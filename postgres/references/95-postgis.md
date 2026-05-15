# PostGIS

PostGIS = canonical geospatial extension for PostgreSQL. Adds `geometry` + `geography` types, ~500+ spatial functions, GiST/SP-GiST/BRIN spatial indexes, raster support, topology support. **Wholly external extension** — versioned independently of PostgreSQL.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
  - [Geometry vs Geography](#geometry-vs-geography)
  - [SRID and ST_Transform](#srid-and-st_transform)
  - [Function Categories](#function-categories)
  - [Spatial Indexing](#spatial-indexing)
  - [Spatial Relationships](#spatial-relationships)
  - [Distance and DWithin](#distance-and-dwithin)
  - [Geometry Processing](#geometry-processing)
  - [Raster Support](#raster-support)
  - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

When working with spatial data in Postgres — coordinates, points, polygons, distance queries, region containment, GIS workflows, mapping applications, geocoding, routing. For vector embeddings see [`94-pgvector.md`](./94-pgvector.md). For fuzzy text similarity see [`93-pg-trgm.md`](./93-pg-trgm.md). For range type overlap (non-spatial) see [`15-data-types-custom.md`](./15-data-types-custom.md).

## Mental Model

Five rules:

1. **PostGIS is THE spatial extension for Postgres.** Wholly external, versioned independently (latest stable **3.6.3** at planning time). Supports PG 12-18. **Zero PostGIS items in PG14/15/16/17/18 release notes** — PostGIS evolves on its own cadence.

2. **`geometry` (planar) vs `geography` (spheroidal) — pick deliberately.** `geometry` does straight-line math in 2D plane — fast, simple, distance in SRS units (degrees if SRID 4326, meters if SRID 3857). `geography` does great-circle math on a spheroid — accurate for global distances + areas, but slower + smaller function set. **Default to `geometry`** unless your data spans continents or you need accurate area/distance over large distances.

3. **SRID identifies coordinate reference system.** SRID 4326 = WGS84 lon/lat (degrees). SRID 3857 = Web Mercator (meters, used by Google Maps / OpenStreetMap tiles). SRID 0 = "no SRS, just numbers." `ST_SetSRID()` assigns SRID metadata WITHOUT transforming coordinates; `ST_Transform()` actually converts coordinates. **Mixed SRIDs in one query = error** ("Operation on mixed SRID geometries").

4. **GiST is default spatial index. SP-GiST for some types. BRIN for naturally-sorted data.** `CREATE INDEX ... USING gist (geom)` is the canonical pattern. GiST supports KNN via `<->` distance operator (nearest-neighbor). SP-GiST quad-tree / k-d tree for 2D + 3D but no KNN. BRIN block-range summaries for append-only spatially-clustered data (e.g., GPS tracks ordered by time + space).

5. **Most query speedup comes from `&&` bounding-box filter on indexed column.** Operators `ST_Intersects`, `ST_DWithin`, `ST_Contains` internally do `&&` (bbox overlap) first using index, then exact GEOS computation on candidates. **Spatial index only accelerates the bbox phase** — the exact-geometry recheck still scans candidates one by one.

> [!WARNING] PostGIS is NOT in core PostgreSQL
> PostGIS = external extension. `CREATE EXTENSION postgis;` after package install. Most managed providers preinstall PostGIS (it's the most-requested extension); self-hosted requires GEOS + Proj + GDAL system libraries. PG14/15/16/17/18 release notes contain ZERO PostGIS items — version PostGIS by its own version, not by PG major.

> [!WARNING] `ST_SetSRID` does NOT transform coordinates
> `ST_SetSRID(geom, 4326)` only **assigns** SRID metadata. If `geom` was actually in SRID 3857 meters and you tag it as 4326, you get nonsense distances forever. Use `ST_Transform(geom, 4326)` to actually convert coordinates from current SRS to 4326.

## Decision Matrix

| Use case | Tool | Rationale |
|---|---|---|
| Lon/lat points + local-region queries | `geometry(Point, 4326)` + GiST | Fast, simple, planar math good enough at local scale |
| Cross-continent distances + areas | `geography(Point, 4326)` + GiST | Spheroidal math handles global accuracy |
| Polygons / regions (boundaries, postal codes, zones) | `geometry(MultiPolygon, 4326)` + GiST | Geometry sufficient; pair with ST_DWithin for distance queries |
| Point-in-polygon "which region?" | `ST_Contains(region, point)` with GiST on region | Fast bbox-filter then exact check |
| "Nearest N stores" KNN | `ORDER BY geom <-> ST_MakePoint(lon, lat) LIMIT N` | KNN-GiST returns sorted nearest |
| "All points within X meters" | `ST_DWithin(geom, point, X)` | Uses GiST `&&` then exact check |
| Polygon overlap detection | `ST_Intersects(a, b)` with GiST | Bbox-accelerated; falls back to GEOS exact |
| Compute area / perimeter | `ST_Area(geog)`, `ST_Perimeter(geog)` | Use geography for square meters; geometry returns SRS units |
| Buffer a point/line into polygon | `ST_Buffer(geom, distance)` | Use geography for meter-radius; geometry for SRS-unit-radius |
| Reproject coordinates | `ST_Transform(geom, target_srid)` | Coordinate conversion (requires Proj library) |
| Raster pixel data (satellite imagery, DEMs) | raster type + ST_Value, ST_Clip | Separate raster module (chapter 11) |
| Topology (shared edges, connected networks) | postgis_topology extension | Separate extension; routing, network analysis |
| 3D / volumetric data | `geometry(PolyhedralSurfaceZ, ...)`, SFCGAL | SFCGAL extension for 3D operations |

Smell signals:

- **No `&&` in query plan but using `ST_Intersects`** — index missing or planner thinks bbox filter not selective enough. Run `ANALYZE`.
- **`geography` everywhere when data is local-scale (one city)** — paying spheroidal-math cost for nothing. Use `geometry(...,3857)` for meter units in local projection.
- **`ST_Distance` in `WHERE x < threshold`** — defeats index. Use `ST_DWithin(a, b, threshold)` instead.

## Syntax / Mechanics

### Geometry vs Geography

Verbatim from PostGIS docs:

- "The basis for the PostGIS `geometry` data type is a plane... functions on geometries... are calculated using straight line vectors."
- "The PostGIS `geography` data type is based on a spherical model... functions on geographies... are calculated using arcs on the sphere."
- "There are fewer functions defined for the `geography` type than for the `geometry` type."

| Property | `geometry` | `geography` |
|---|---|---|
| Math model | Planar (Cartesian) | Spheroidal (great-circle) |
| Default SRID | 0 (no SRS) | 4326 (WGS84) |
| Distance units | SRS units (degrees for 4326, meters for 3857) | Meters always |
| Speed | Fast | 2-10x slower |
| Function coverage | ~500 functions | Subset of `geometry` functions |
| Index | GiST / SP-GiST / BRIN | GiST only |
| Best for | Local-scale, in-projection data | Global distances, areas |

Cast between: `geom::geography` and `geog::geometry`. Casting `geometry` SRID 0 to `geography` errors — need actual SRID first.

Type modifier syntax:

```sql
-- subtype constraint
CREATE TABLE places (
    id bigserial PRIMARY KEY,
    location geometry(Point, 4326) NOT NULL,
    boundary geometry(MultiPolygon, 4326),
    region geography(Polygon, 4326)
);
```

Valid subtype names: `Point`, `LineString`, `Polygon`, `MultiPoint`, `MultiLineString`, `MultiPolygon`, `GeometryCollection`, `CircularString`, `CompoundCurve`, `CurvePolygon`, `MultiCurve`, `MultiSurface`, `PolyhedralSurface`, `Triangle`, `TIN`. Add `Z`, `M`, or `ZM` suffix for 3D / measured / both (e.g., `PointZ`, `LineStringZM`).

### SRID and ST_Transform

| Function | Purpose |
|---|---|
| `ST_SetSRID(geom, srid)` | **Assigns** SRID metadata; does NOT transform coords |
| `ST_Transform(geom, target_srid)` | **Reprojects** coords from current SRS to target SRS |
| `ST_SRID(geom)` | Returns current SRID |
| `ST_AsEWKT(geom)` | Output as Extended WKT: `SRID=4326;POINT(-122.4 37.8)` |
| `ST_GeomFromText('POINT(...)', srid)` | Construct geometry from WKT with explicit SRID |
| `ST_GeomFromEWKT('SRID=n;...')` | Construct from EWKT (SRID embedded) |
| `ST_MakePoint(x, y)` | Fast point constructor; SRID = 0 default; chain with `ST_SetSRID` |

Common SRIDs:

| SRID | Name | Units | Use |
|---|---|---|---|
| 4326 | WGS84 lon/lat | degrees | GPS, OpenStreetMap, GeoJSON default |
| 3857 | Web Mercator | meters | Map tiles (Google, OSM, Mapbox) |
| 4269 | NAD83 lon/lat | degrees | US Census, USGS data |
| 2163 | US National Atlas | meters | Equal-area US-wide |
| 27700 | OSGB36 / British National Grid | meters | UK Ordnance Survey |
| 3035 | ETRS89-extended | meters | EU equal-area |

Transformation example:

```sql
-- Convert WGS84 lon/lat → Web Mercator meters
SELECT ST_Transform(
    ST_SetSRID(ST_MakePoint(-122.4194, 37.7749), 4326),
    3857
);
-- Returns: SRID=3857;POINT(-13627665.27 4544402.6)
```

Mixing SRIDs in one operation errors:

```
ERROR: Operation on mixed SRID geometries (Point, 4326) != (Point, 3857)
```

Fix: transform one to match the other.

### Function Categories

PostGIS reference (Chapter 7) groups functions into 23 categories. Most operationally relevant:

| Category | Examples |
|---|---|
| Constructors | `ST_MakePoint`, `ST_MakeLine`, `ST_MakePolygon`, `ST_GeomFromText` |
| Accessors | `ST_X`, `ST_Y`, `ST_NumPoints`, `ST_GeometryType`, `ST_IsValid` |
| Spatial References | `ST_SRID`, `ST_SetSRID`, `ST_Transform` |
| I/O | `ST_AsText`, `ST_AsEWKT`, `ST_AsBinary`, `ST_AsGeoJSON`, `ST_AsKML`, `ST_AsMVT` |
| Operators | `&&` (bbox overlap), `<->` (KNN distance), `~=` (exact equal) |
| Spatial Relationships | `ST_Intersects`, `ST_Contains`, `ST_Within`, `ST_Touches`, `ST_Crosses`, `ST_Overlaps`, `ST_Equals`, `ST_Covers` |
| Measurement | `ST_Distance`, `ST_DWithin`, `ST_Area`, `ST_Length`, `ST_Perimeter` |
| Overlay | `ST_Union`, `ST_Intersection`, `ST_Difference`, `ST_SymDifference` |
| Processing | `ST_Buffer`, `ST_Simplify`, `ST_Centroid`, `ST_ConvexHull`, `ST_ConcaveHull` |
| Aggregates | `ST_Collect`, `ST_Union` (agg form), `ST_Extent`, `ST_ClusterDBSCAN` |
| Affine | `ST_Translate`, `ST_Scale`, `ST_Rotate` |
| Linear Referencing | `ST_LineInterpolatePoint`, `ST_LineLocatePoint` |
| Trajectory | `ST_IsValidTrajectory`, `ST_ClosestPointOfApproach` |
| Bounding Box | `ST_Envelope`, `Box2D`, `Box3D`, `ST_Expand` |

### Spatial Indexing

**GiST is the default.** Always create one on `geometry` / `geography` columns used in spatial predicates.

```sql
CREATE INDEX places_location_gix ON places USING gist (location);
CREATE INDEX places_region_gix ON places USING gist (region);
```

GiST supports:
- `&&` bounding-box overlap (used internally by all spatial predicates)
- `ST_Intersects`, `ST_Contains`, `ST_Within`, `ST_DWithin`, `ST_Crosses`, `ST_Touches`, `ST_Overlaps`, `ST_Equals`, `ST_Covers`
- `<->` KNN distance ordering (`ORDER BY geom <-> point LIMIT N`)

GiST operator classes for `geometry`:

| Opclass | Index dimensions | When |
|---|---|---|
| `gist_geometry_ops_2d` | 2D bbox (default) | Most cases |
| `gist_geometry_ops_nd` | n-D bbox | If using 3D / 4D queries |

```sql
-- n-dimensional GiST for 3D geometry
CREATE INDEX places_3d_gix ON places USING gist (location_3d gist_geometry_ops_nd);
```

**SP-GiST** for `geometry`:

```sql
CREATE INDEX places_spgist ON places USING spgist (location);
```

Opclasses: `spgist_geometry_ops_2d`, `spgist_geometry_ops_3d`, `spgist_geometry_ops_nd`. Quad-tree (2D) or k-d tree (3D/nD). Smaller index than GiST, similar query time. **No KNN support** — cannot order by `<->`.

**BRIN** for naturally-sorted spatial data (e.g., GPS tracks ordered by time + space, satellite imagery raster blocks):

```sql
CREATE INDEX tracks_brin ON tracks USING brin (geom);
```

Opclasses: `brin_geometry_inclusion_ops_2d`, `..._3d`, `..._4d`. Tiny index (10000x smaller than GiST). Lossy — requires recheck. Fast build, slow queries unless data is spatially clustered on disk.

**`ANALYZE` after bulk loads** — PostGIS uses planner statistics on geometry columns:

```sql
ANALYZE places;
```

### Spatial Relationships

Boolean predicates returning `true` / `false`. All bbox-accelerated by spatial index.

| Function | Definition |
|---|---|
| `ST_Intersects(a, b)` | Geometries share any point. Most common predicate. |
| `ST_Contains(a, b)` | Every point of `b` is inside `a`, AND interiors intersect. |
| `ST_Within(a, b)` | `a` is contained by `b`. Inverse of `ST_Contains(b, a)`. |
| `ST_Covers(a, b)` | Every point of `b` is in `a` (boundaries allowed). Less strict than Contains. |
| `ST_CoveredBy(a, b)` | Every point of `a` is in `b`. Inverse of Covers. |
| `ST_Touches(a, b)` | Boundaries touch but interiors do not intersect. |
| `ST_Crosses(a, b)` | Geometries cross but neither contains the other. |
| `ST_Overlaps(a, b)` | Same dimension, some shared but neither contains. |
| `ST_Disjoint(a, b)` | No shared points. Negation of Intersects. **Not index-accelerated** (must compare to ALL rows). |
| `ST_Equals(a, b)` | Same set of points (not necessarily same vertex order). |

Index plan example:

```sql
EXPLAIN ANALYZE
SELECT id FROM places
WHERE ST_Intersects(location, ST_MakeEnvelope(-122.5, 37.7, -122.3, 37.9, 4326));
-- Bitmap Index Scan on places_location_gix
--   Index Cond: (location && '...envelope...')
-- Bitmap Heap Scan recheck: ST_Intersects(location, '...envelope...')
```

The `&&` index condition is the bbox filter; the recheck on the heap is exact-geometry check.

### Distance and DWithin

```sql
-- DWithin: index-accelerated "within N units"
SELECT id, name FROM places
WHERE ST_DWithin(location, ST_MakePoint(-122.4, 37.8)::geometry, 0.01);
-- Note: 0.01 is in SRS units (degrees for 4326); not meters

-- Use geography for meter-radius
SELECT id, name FROM places
WHERE ST_DWithin(location::geography, ST_MakePoint(-122.4, 37.8)::geography, 500);
-- 500 = 500 meters

-- KNN nearest-N
SELECT id, name, ST_Distance(location, ST_MakePoint(-122.4, 37.8)::geometry) AS dist
FROM places
ORDER BY location <-> ST_MakePoint(-122.4, 37.8)::geometry
LIMIT 10;
```

**Operator `<->`** = bounding-box centroid distance for GiST KNN; the `ORDER BY` triggers index-only-scan for nearest-N. Pair with `LIMIT` for the index to drive ordering.

`ST_Distance`:

```sql
-- Distance between geometries (SRS units for geometry, meters for geography)
SELECT ST_Distance(a.location, b.location) FROM places a, places b WHERE ...;

-- Geography uses spheroid by default; pass false for sphere (faster, less accurate)
SELECT ST_Distance(a::geography, b::geography, false);  -- sphere
SELECT ST_Distance(a::geography, b::geography);          -- spheroid (default)
```

### Geometry Processing

```sql
-- Buffer (polygon of all points within distance)
SELECT ST_Buffer(ST_MakePoint(0, 0)::geometry, 100);   -- 100 SRS units
SELECT ST_Buffer(ST_MakePoint(-122, 37)::geography, 1000);  -- 1000 meters

-- Buffer with style options
SELECT ST_Buffer(line, 50, 'quad_segs=8 endcap=round join=round');

-- Simplify (reduce vertex count)
SELECT ST_Simplify(polygon, 0.001);  -- tolerance in SRS units

-- Centroid (geometric center)
SELECT ST_Centroid(polygon);

-- Convex hull (smallest convex polygon enclosing geometry)
SELECT ST_ConvexHull(ST_Collect(point_array));

-- Union (combine into one geometry)
SELECT ST_Union(regions) FROM regions;

-- Intersection
SELECT ST_Intersection(zone_a, zone_b);

-- Difference
SELECT ST_Difference(country, water_bodies);
```

`ST_Buffer` on `geography`: distance in meters; uses planar buffer at appropriate projection then converts back.

### Raster Support

PostGIS includes raster type (chapter 11) for pixel data — satellite imagery, DEMs (digital elevation models), thermal maps. Enable via:

```sql
CREATE EXTENSION postgis_raster;
```

Key types + functions:

- `raster` type — collection of bands, georeferenced (origin + pixel size + SRID)
- `raster2pgsql` CLI — load GeoTIFF / IMG / etc. into raster column
- `ST_Value(rast, geom)` — sample pixel value at a point
- `ST_Clip(rast, polygon)` — extract subset
- `ST_Reclass(rast, expr)` — reclassify values
- `ST_AsTIFF(rast)` — export

> [!NOTE] PostGIS raster
> Raster module not loaded by default — requires `CREATE EXTENSION postgis_raster`. Some managed providers don't ship raster module due to GDAL dependency. Verify before designing around it.

### Per-Version Timeline

| PostGIS version | Released | Highlight |
|---|---|---|
| **3.0** | 2019-10 | First major release after merger of `postgis_topology` etc. into core. GEOS 3.8 baseline. |
| **3.1** | 2020-12 | `ST_HilbertCode`, `ST_Hexagon`, performance for large geometry collections. |
| **3.2** | 2022-02 | `ST_Letters`, performance for vector tiles (`ST_AsMVT`). |
| **3.3** | 2022-08 | New cluster functions, performance improvements. |
| **3.4** | 2023-09 | `ST_LargestEmptyCircle`, `ST_CoverageUnion`, schema migration improvements. |
| **3.5** | 2024-09 | `ST_HasArc`, lattice / coverage support, dropped EOL'd PG versions. Latest in 3.5 series: 3.5.6 (Apr 2026). |
| **3.6** | 2025-Q4 | Latest stable: **3.6.3** at planning time (2026-05-14). RelateNG support (faster spatial predicates), GEOS 3.13 features. |

**Key:** PG14/15/16/17/18 release notes contain **ZERO** PostGIS items. PostGIS evolves on its own schedule.

PostGIS 3.6 support matrix (per install docs): PostgreSQL 12 through 18, GEOS 3.8+, Proj 6.1+, GDAL 2.4+.

## Examples / Recipes

### Recipe 1: Baseline schema for points + regions

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE stores (
    id        bigserial PRIMARY KEY,
    name      text NOT NULL,
    location  geometry(Point, 4326) NOT NULL
);

CREATE TABLE service_areas (
    id        bigserial PRIMARY KEY,
    region    text NOT NULL,
    boundary  geometry(MultiPolygon, 4326) NOT NULL
);

CREATE INDEX stores_location_gix ON stores USING gist (location);
CREATE INDEX service_areas_boundary_gix ON service_areas USING gist (boundary);

ANALYZE stores;
ANALYZE service_areas;
```

### Recipe 2: Find nearest N stores to a point

```sql
SELECT id, name,
       ST_Distance(location::geography, ST_MakePoint(-122.4, 37.8)::geography) AS meters
FROM stores
ORDER BY location <-> ST_SetSRID(ST_MakePoint(-122.4, 37.8), 4326)
LIMIT 10;
```

`<->` triggers KNN-GiST index scan. `ORDER BY` + `LIMIT` are required. Cast to `geography` only inside the `ST_Distance` for accurate meters; keep the `ORDER BY` on `geometry` so the index drives ordering.

### Recipe 3: Find all stores within 500 meters

```sql
SELECT id, name
FROM stores
WHERE ST_DWithin(
    location::geography,
    ST_MakePoint(-122.4, 37.8)::geography,
    500
);
```

Geography variant. Distance in meters. Index-accelerated via `&&` bbox filter on geography (geography GiST supports it).

### Recipe 4: Point-in-polygon — which region contains a point?

```sql
SELECT s.region
FROM service_areas s
WHERE ST_Contains(s.boundary, ST_SetSRID(ST_MakePoint(-122.4, 37.8), 4326));
```

Or "which region is this point in?" with index plan:

```sql
EXPLAIN ANALYZE
SELECT region FROM service_areas
WHERE ST_Contains(boundary, ST_SetSRID(ST_MakePoint(-122.4, 37.8), 4326));
-- Bitmap Index Scan on service_areas_boundary_gix
--   Index Cond: (boundary && ...point...)
-- Recheck: ST_Contains(boundary, ...point...)
```

### Recipe 5: Polygon overlap detection

```sql
-- Find pairs of overlapping zones
SELECT a.id AS zone_a, b.id AS zone_b
FROM zones a JOIN zones b ON a.id < b.id
WHERE ST_Intersects(a.geom, b.geom);
```

Self-join. Both sides need GiST index.

### Recipe 6: Area computation in square meters

```sql
-- Use geography for accurate area
SELECT region, ST_Area(boundary::geography) / 1000000 AS km2
FROM service_areas
ORDER BY km2 DESC;
```

`ST_Area(geometry)` returns SRS units squared (degrees² for 4326 — meaningless). `ST_Area(geography)` returns square meters always.

### Recipe 7: Reproject WGS84 → Web Mercator for tile rendering

```sql
-- Source: GeoJSON ingested as SRID 4326
-- Target: Mapbox-style tiles need SRID 3857 (Web Mercator)
UPDATE stores
SET location_3857 = ST_Transform(location, 3857);

CREATE INDEX stores_3857_gix ON stores USING gist (location_3857);
```

### Recipe 8: Buffer + intersect — find stores within 1km of any park

```sql
-- Build park buffers once, query against them
WITH park_buffers AS (
    SELECT ST_Union(ST_Buffer(geom::geography, 1000)::geometry) AS buffer
    FROM parks
)
SELECT s.id, s.name
FROM stores s, park_buffers p
WHERE ST_Intersects(s.location, p.buffer);
```

Or precompute buffers as materialized view + index.

### Recipe 9: Cluster nearby points (DBSCAN)

```sql
SELECT id, name,
       ST_ClusterDBSCAN(location, eps := 0.001, minpoints := 5) OVER () AS cluster_id
FROM events
WHERE created_at > now() - interval '24 hours';
```

`eps` = max distance (SRS units). `minpoints` = min cluster size. Returns NULL for noise.

### Recipe 10: Generate vector tiles (MVT)

```sql
WITH bbox AS (
    SELECT ST_TileEnvelope(z, x, y) AS env
),
tile_features AS (
    SELECT id, name, ST_AsMVTGeom(geom, bbox.env, 4096, 256, true) AS geom
    FROM features, bbox
    WHERE geom && bbox.env
)
SELECT ST_AsMVT(tile_features.*, 'features') FROM tile_features;
```

Returns binary MVT format consumable by Mapbox-GL, Maplibre, OpenLayers vector tile layers.

### Recipe 11: Validate and fix invalid geometries

```sql
-- Find invalid geometries
SELECT id, ST_IsValidReason(geom)
FROM features
WHERE NOT ST_IsValid(geom);

-- Fix via MakeValid
UPDATE features
SET geom = ST_MakeValid(geom)
WHERE NOT ST_IsValid(geom);
```

GiST indexes on invalid geometries can give wrong query results — clean before indexing.

### Recipe 12: Audit PostGIS objects cluster-wide

```sql
-- Find all geometry/geography columns
SELECT f_table_schema AS schema_name,
       f_table_name   AS table_name,
       f_geometry_column AS column_name,
       type, srid, coord_dimension
FROM geometry_columns
ORDER BY 1, 2;

-- Or directly from pg_attribute + pg_type
SELECT n.nspname, c.relname, a.attname, t.typname
FROM pg_attribute a
JOIN pg_class c ON a.attrelid = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
JOIN pg_type t ON a.atttypid = t.oid
WHERE t.typname IN ('geometry', 'geography')
  AND c.relkind IN ('r', 'p')
  AND a.attnum > 0;

-- PostGIS version + GEOS/Proj/GDAL versions
SELECT PostGIS_Full_Version();
```

### Recipe 13: Find tables missing spatial indexes

```sql
SELECT n.nspname, c.relname, a.attname
FROM pg_attribute a
JOIN pg_class c ON a.attrelid = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
JOIN pg_type t ON a.atttypid = t.oid
WHERE t.typname IN ('geometry', 'geography')
  AND c.relkind IN ('r', 'p')
  AND a.attnum > 0
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_am am ON i.indexrelid IN (
        SELECT oid FROM pg_class WHERE relam = am.oid
    )
    WHERE i.indrelid = a.attrelid
      AND a.attnum = ANY(i.indkey)
      AND am.amname IN ('gist', 'spgist', 'brin')
  );
```

## Gotchas / Anti-patterns

1. **`ST_SetSRID` does NOT transform coordinates** — only assigns SRID metadata. Wrong SRID assignment = forever-wrong distance queries. Use `ST_Transform` for actual reprojection.

2. **Mixing SRIDs in one query errors** — "Operation on mixed SRID geometries." All arguments must share SRID; use `ST_Transform` to align.

3. **`geometry` `ST_Distance` returns SRS units** — for `geometry(Point, 4326)`, distance is in **degrees** (~111 km per degree at equator, less near poles). Cast to `geography` for meters: `ST_Distance(a::geography, b::geography)`.

4. **`ST_Disjoint` not index-accelerated** — has to compare to all rows. Rewrite as `NOT ST_Intersects(a, b)` which IS index-accelerated.

5. **`ST_Distance` in `WHERE ... < N` defeats index** — `WHERE ST_Distance(a, point) < 0.01` does seq scan. Rewrite as `ST_DWithin(a, point, 0.01)` for index-accelerated bbox + exact check.

6. **No KNN with SP-GiST** — SP-GiST does not support `<->` operator. For nearest-neighbor queries, use GiST.

7. **Invalid geometries silently break index queries** — `ST_IsValid` returns false for self-intersections, ring orientations, etc. Validate before bulk loads: `ALTER TABLE features ADD CONSTRAINT geom_valid CHECK (ST_IsValid(geom));` or fix with `ST_MakeValid`.

8. **GiST recheck cost dominates on huge result sets** — `&&` is fast bbox match; exact `ST_Intersects` recheck is GEOS computation per candidate. For approximate queries on millions of polygons, the recheck phase may take longer than the index scan.

9. **`ST_Contains` differs from `ST_Covers` on boundaries** — `ST_Contains(A, B)` requires B strictly inside A (boundaries don't count). `ST_Covers(A, B)` accepts boundary-touching points. For "any point on a region boundary belongs to that region," use `ST_Covers`.

10. **`ST_Within(A, B)` is inverse of `ST_Contains(B, A)`** — easy to get arg order wrong. Mnemonic: "A is within B" = "B contains A."

11. **Geography always uses spheroid by default; can be slow** — pass `false` as third arg for sphere approximation: `ST_Distance(a::geography, b::geography, false)` 2-3x faster but ~0.5% less accurate.

12. **`ST_Buffer` on `geography` uses planar projection internally** — accurate for small distances (<100 km), degrades for buffers spanning hemispheres. For continent-scale buffers consider segment-by-segment approach.

13. **`raster` not loaded by default** — separate `CREATE EXTENSION postgis_raster`; some managed providers omit it.

14. **`geography` does not support 3D / Z coordinates** — only `geometry` does. If you need elevation, use `geometry(PointZ, 4326)`.

15. **PG18 collation determinism rule** — PG18 requires PK/FK columns to share collation. PostGIS geometry/geography are not text — unaffected. But if you mix `text` joins with spatial joins, see [`87-major-version-upgrade.md`](./87-major-version-upgrade.md).

16. **`pg_upgrade` requires PostGIS on target cluster BEFORE upgrade** — same trap as pgvector. Install matching-or-newer PostGIS version on new cluster before running `pg_upgrade`. Cross-reference [`86-pg-upgrade.md`](./86-pg-upgrade.md) gotcha #5.

17. **PostGIS major upgrades may require `ALTER EXTENSION postgis UPDATE`** — after package upgrade, run UPDATE inside each database. Some major version transitions (e.g., 2.x → 3.x) required `postgis_extensions_upgrade()` helper.

18. **Spatial-only indexes don't help non-spatial filters** — `WHERE ST_Intersects(geom, env) AND status = 'active'` may need composite or partial index for `status`. Plain B-tree on `status` plus GiST on `geom` = bitmap-AND plan.

19. **Geometry columns count toward 1600-column table limit** — geometry isn't free at the catalog level. Wide spatial tables hit limit faster.

20. **`ST_AsGeoJSON` defaults to 9 decimal places** — high precision = larger payload. Pass `maxdecimaldigits` arg: `ST_AsGeoJSON(geom, 6)` for ~10cm precision (sufficient for most maps).

21. **`ST_MakePoint(lat, lon)` is backwards** — function takes `(x, y)` = `(longitude, latitude)`. Easy to flip when copying from latitude/longitude data sources.

22. **Empty geometries cause `ST_IsValid` to return TRUE** — `ST_IsEmpty(geom)` is separate check. Some operations on empty geometries return NULL silently.

23. **PG14/15/16/17/18 release notes mention PostGIS zero times** — verify against PostGIS release notes directly at `postgis.net/docs/manual-3.5/release_notes.html` (or current manual). Tutorials claiming "PG17 improved PostGIS" should be verified — PostGIS evolves independently.

## See Also

- [`94-pgvector.md`](./94-pgvector.md) — semantic similarity via vector embeddings (different problem: meaning, not space)
- [`93-pg-trgm.md`](./93-pg-trgm.md) — fuzzy text matching (geocoding may use trigram + spatial together)
- [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) — GiST mechanics PostGIS depends on
- [`25-brin-hash-spgist-bloom-indexes.md`](./25-brin-hash-spgist-bloom-indexes.md) — SP-GiST + BRIN for spatial data
- [`15-data-types-custom.md`](./15-data-types-custom.md) — range types (1D non-spatial analog)
- [`26-index-maintenance.md`](./26-index-maintenance.md) — REINDEX after upgrades
- [`53-server-configuration.md`](./53-server-configuration.md) — `max_locks_per_transaction` may need raise for many partitioned spatial tables
- [`54-memory-tuning.md`](./54-memory-tuning.md) — work_mem for spatial joins
- [`56-explain.md`](./56-explain.md) — read spatial-index plans
- [`69-extensions.md`](./69-extensions.md) — `CREATE EXTENSION postgis` + ALTER EXTENSION UPDATE
- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) — pg_dump and PostGIS object dependencies
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — PostGIS must be on target before pg_upgrade
- [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) — PostGIS major-version dance
- [`96-timescaledb.md`](./96-timescaledb.md) — common IoT/geospatial use case overlap (GPS tracks, sensor locations with timestamps)
- [`100-pg-versions-features.md`](./100-pg-versions-features.md) — per-version context; PostGIS evolves on its own cadence outside PG14-18 release notes
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — managed providers and PostGIS allowlists
- [`102-skill-cookbook.md`](./102-skill-cookbook.md) — synthesis recipes referencing spatial index patterns

## Sources

[^1]: PostGIS project homepage — https://postgis.net/ (verified 2026-05-14, version banner "PostGIS 3.2 - 3.6")
[^2]: PostGIS documentation hub — https://postgis.net/documentation/ (verified 2026-05-14)
[^3]: PostGIS 3.6 manual (current dev branch) — https://postgis.net/docs/ (verified 2026-05-14, "3.6.4dev" as of May 11, 2026)
[^4]: PostGIS 3.5 manual — https://postgis.net/docs/manual-3.5/ (verified 2026-05-14, "3.5.7dev" — 3.5.6 latest stable release)
[^5]: PostGIS reference (Chapter 7, all functions) — https://postgis.net/docs/reference.html (verified 2026-05-14)
[^6]: Using PostGIS: data management — https://postgis.net/docs/using_postgis_dbmanagement.html (verified 2026-05-14) — verbatim: "The basis for the PostGIS `geometry` data type is a plane..." and "The PostGIS `geography` data type is based on a spherical model..."
[^7]: PostGIS install requirements — https://postgis.net/docs/manual-3.5/postgis_installation.html (verified 2026-05-14) — PG 12-18, GEOS 3.8+, Proj 6.1+, GDAL 2.4+
[^8]: PostGIS release notes — https://postgis.net/docs/manual-3.5/release_notes.html (verified 2026-05-14, covers 3.5.0 through 3.5.6, Sept 2024 to Apr 2026)
[^9]: PostGIS source downloads — https://postgis.net/source/ (verified 2026-05-14, latest stable `postgis-3.6.3.tar.gz`)
[^10]: PostGIS GitHub mirror — https://github.com/postgis/postgis (verified 2026-05-14, mirror of canonical OSGeo repo)
[^11]: PostGIS workshop (intro tutorial) — https://postgis.net/workshops/postgis-intro/ (verified 2026-05-14, 43 modules)
[^12]: ST_DWithin documentation — https://postgis.net/docs/ST_DWithin.html (verified 2026-05-14)
[^13]: ST_Intersects documentation — https://postgis.net/docs/ST_Intersects.html (verified 2026-05-14)
[^14]: ST_Transform documentation — https://postgis.net/docs/ST_Transform.html (verified 2026-05-14)
[^15]: ST_Distance documentation — https://postgis.net/docs/ST_Distance.html (verified 2026-05-14)
[^16]: ST_Buffer documentation — https://postgis.net/docs/ST_Buffer.html (verified 2026-05-14)
[^17]: ST_Contains documentation — https://postgis.net/docs/ST_Contains.html (verified 2026-05-14)
[^18]: ST_Within documentation — https://postgis.net/docs/ST_Within.html (verified 2026-05-14)
[^19]: ST_MakePoint documentation — https://postgis.net/docs/ST_MakePoint.html (verified 2026-05-14)
[^20]: ST_SetSRID documentation — https://postgis.net/docs/ST_SetSRID.html (verified 2026-05-14)
[^21]: Raster data management chapter — https://postgis.net/docs/manual-3.5/using_raster_dataman.html (verified 2026-05-14)
[^22]: PostGIS Special Functions Index — https://postgis.net/docs/manual-3.5/PostGIS_Special_Functions_Index.html (verified 2026-05-14, 500+ functions across 12 categories)
[^23]: PostgreSQL 14 release notes — https://www.postgresql.org/docs/14/release-14.html (verified 2026-05-14, ZERO PostGIS items)
[^24]: PostgreSQL 15 release notes — https://www.postgresql.org/docs/15/release-15.html (verified 2026-05-14, ZERO PostGIS items)
[^25]: PostgreSQL 16 release notes — https://www.postgresql.org/docs/16/release-16.html (verified 2026-05-14, ZERO PostGIS items)
[^26]: PostgreSQL 17 release notes — https://www.postgresql.org/docs/17/release-17.html (verified 2026-05-14, ZERO PostGIS items)
[^27]: PostgreSQL 18 release notes — https://www.postgresql.org/docs/18/release-18.html (verified 2026-05-14, ZERO PostGIS items)
