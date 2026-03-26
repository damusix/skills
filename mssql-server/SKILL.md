---
name: mssql-server
description: >
  Writes, optimizes, and debugs T-SQL queries. Explains SQL Server internals,
  troubleshoots performance issues, and guides database administration tasks
  including backup/restore, high availability, security, and index design.
  Use when the user asks about T-SQL syntax, SQL Server administration,
  query performance, stored procedures, indexes, locking, transactions,
  backup/restore, high availability, security, or any MSSQL-related
  topic — even without saying "SQL Server" explicitly. Also trigger on
  terms like SSMS, tempdb, bcp, sqlcmd, MSSQL, sp_executesql, NOLOCK,
  columnstore, Hekaton, RCSI, param sniffing, or execution plan.
---

# MSSQL Server Skill

## How to use this skill

When this skill triggers, follow this workflow:

1. **Identify the topic** using the routing table below (keyword → file mapping).
2. **Read the relevant reference file(s).** Never answer from memory alone when a reference file covers the topic.
3. **For cross-cutting questions** (e.g., "optimize a stored proc with dynamic SQL and parameter sniffing"): identify ALL matching rows in the routing table and read each file. Check the "See Also" section in the first file for additional files to load. Synthesize across files and state which files you drew from.
4. **For ambiguous keywords** that appear in multiple routing rows: read the "Disambiguation" column. When in doubt, load both files — a broader answer is better than a wrong routing.
5. **Answer using the reference file content:** cite the specific section, include T-SQL examples, note version constraints with admonition blocks, and cite the source URL for non-obvious claims.
6. **Response format:**
    - Lead with the direct answer or recommended pattern (code first when applicable)
    - Follow with caveats, gotchas, or version notes in admonition blocks
    - End with source links for key claims
    - Use headers matching the reference file sections so the user can trace the source

---

## Routing Table


| Keywords / Triggers | File | Scope | Disambiguation |
|---|---|---|---|
| CREATE TABLE, ALTER TABLE, DROP, schema, sequence, synonym, computed column | `references/01-syntax-ddl.md` | DDL syntax reference | |
| SELECT, JOIN, subquery, UNION, INTERSECT, EXCEPT, window function, PIVOT, UNPIVOT, APPLY, OFFSET FETCH, pagination | `references/02-syntax-dql.md` | DQL / query syntax | |
| INSERT, UPDATE, DELETE, MERGE, OUTPUT clause, upsert | `references/03-syntax-dml.md` | DML syntax & patterns | |
| CTE, WITH, recursive CTE, anchor member, MAXRECURSION | `references/04-ctes.md` | CTEs (recursive & non-recursive) | |
| VIEW, indexed view, SCHEMABINDING, partitioned view, WITH CHECK OPTION | `references/05-views.md` | Views | |
| stored procedure, param sniffing, TVP, output param, EXECUTE AS user, impersonation, security context | `references/06-stored-procedures.md` | Stored procedures | **OPTION RECOMPILE**: here for proc-level usage; see also 32 for query-level hint. **EXECUTE AS**: here for proc context; see also 15 for server/db principals |
| function, scalar UDF, inline TVF, multi-statement TVF, determinism, UDF inlining | `references/07-functions.md` | User-defined functions | |
| index, clustered, nonclustered, covering index, include columns, fill factor, fragmentation, heap, forwarded record, rebuild, reorganize, B-tree structure | `references/08-indexes.md` | Index design & maintenance | **missing index**: here for DMV queries and index design; see also 32 for broader perf diagnostics |
| columnstore, delta store, rowgroup, batch mode, tuple mover, segment elimination | `references/09-columnstore-indexes.md` | Columnstore indexes | |
| partition, partition function, partition scheme, partition switching, sliding window, STATISTICS_INCREMENTAL | `references/10-partitioning.md` | Table partitioning | |
| user-defined type, CLR type, table type, alias type, spatial, geometry, geography, sparse column | `references/11-custom-data-types.md` | Custom data types | |
| CHECK constraint, DEFAULT constraint, UNIQUE constraint, foreign key, cascade, referential integrity, functional constraint, cross-database constraint, cross-schema, computed column index | `references/12-custom-defaults-rules.md` | Constraints & defaults | |
| transaction, isolation level, SNAPSHOT, RCSI, READ_COMMITTED_SNAPSHOT, ALLOW_SNAPSHOT_ISOLATION, MVCC, row versioning, lock escalation, lock hint, NOLOCK, UPDLOCK, ROWLOCK | `references/13-transactions-locking.md` | Transactions & locking | **deadlock**: here for theory, prevention, lock mechanics; see also 33 for XE deadlock graph capture. **wait stats**: here for lock-related waits; see also 32 for full wait stats diagnostics |
| TRY CATCH, THROW, RAISERROR, error handling, savepoint, @@TRANCOUNT, XACT_ABORT | `references/14-error-handling.md` | Error handling | |
| login, user, role, server principal, database principal, GRANT, DENY, REVOKE, permission, ownership chaining, application role | `references/15-principals-permissions.md` | Principals & permissions | **EXECUTE AS**: here for principal impersonation; see also 06 for proc-level EXECUTE AS |
| RLS, row-level security, dynamic data masking, TDE, Always Encrypted, column encryption, certificate, DDM, encryption algorithm, AES, RSA, CEK, CMK, key rotation, HSM | `references/16-security-encryption.md` | Security & encryption | |
| temporal table, system-versioned, AS OF, time travel, FOR SYSTEM_TIME, retention policy | `references/17-temporal-tables.md` | Temporal tables | |
| In-Memory OLTP, Hekaton, memory-optimized table, natively compiled, hash index, range index, durability | `references/18-in-memory-oltp.md` | In-Memory OLTP | |
| JSON, XML, FOR JSON, FOR XML, OPENJSON, JSON_VALUE, JSON_QUERY, JSON_MODIFY, XQuery, XML index | `references/19-json-xml.md` | JSON & XML | |
| full-text search, FTS, CONTAINS, FREETEXT, CONTAINSTABLE, FREETEXTTABLE, semantic search, stopword, thesaurus | `references/20-full-text-search.md` | Full-text & semantic search | |
| graph table, node table, edge table, MATCH, SHORTEST_PATH, multi-hop, graph traversal | `references/21-graph-tables.md` | Graph tables | |
| ledger table, append-only ledger, updatable ledger, digest, ledger verification, blockchain | `references/22-ledger-tables.md` | Ledger tables | |
| dynamic SQL, sp_executesql, SQL injection, parameterized query, dynamic WHERE, EXEC | `references/23-dynamic-sql.md` | Dynamic SQL | |
| string function, date function, math function, STRING_AGG, CONCAT_WS, FORMAT, DATEADD, DATEDIFF, AT TIME ZONE, datetime2, datetimeoffset, TRIM, TRANSLATE | `references/24-string-date-math-functions.md` | Built-in functions reference | |
| NULL, ISNULL, COALESCE, NULLIF, three-valued logic, IS DISTINCT FROM, nullable index | `references/25-null-handling.md` | NULL handling | |
| collation, case-sensitive, accent-sensitive, COLLATE clause, collation conflict, Latin1_General, BIN2 | `references/26-collation.md` | Collation | |
| cursor, FAST_FORWARD, KEYSET, STATIC, DYNAMIC, FORWARD_ONLY, cursor anti-pattern | `references/27-cursors.md` | Cursors | |
| statistics, auto-update, ascending key, histogram, DBCC SHOW_STATISTICS, UPDATE STATISTICS, filtered statistics | `references/28-statistics.md` | Statistics | |
| execution plan, SHOWPLAN, STATISTICS IO, STATISTICS TIME, Index Seek, Key Lookup, Hash Join, Nested Loop, cardinality, plan warning, implicit conversion | `references/29-query-plans.md` | Query plans | |
| Query Store, regressed query, forced plan, PSPO, parameter-sensitive plan, CE feedback | `references/30-query-store.md` | Query Store | **wait stats**: here for QS-integrated wait stats; see also 32 for server-level wait stats |
| IQP, Intelligent Query Processing, memory grant feedback, batch mode on rowstore, interleaved execution, DOP feedback, table variable deferred compilation, approximate count | `references/31-intelligent-query-processing.md` | Intelligent Query Processing | |
| wait stats, missing index DMV, plan cache, OPTION RECOMPILE, MAXDOP hint, sp_Blitz, sp_BlitzCache, sp_BlitzFirst, sp_BlitzIndex, FORCESEEK, FORCESCAN | `references/32-performance-diagnostics.md` | Performance diagnostics | **OPTION RECOMPILE**: here for query hint usage; see also 06 for proc-level param sniffing. **missing index**: here for perf triage; see also 08 for index design decisions |
| Extended Events, XE session, deadlock graph, blocking detection, ring buffer, event file, sys.dm_xe | `references/33-extended-events.md` | Extended Events | **deadlock graph**: here for XE capture mechanics; see also 13 for deadlock theory and prevention |
| tempdb, TF 1117, TF 1118, GAM, SGAM, PFS, allocation latch, temp table, table variable, version store | `references/34-tempdb.md` | tempdb | |
| DBCC, CHECKDB, FREEPROCCACHE, DROPCLEANBUFFERS, SHRINKFILE, SHRINKDATABASE, UPDATEUSAGE, INPUTBUFFER, OPENTRAN | `references/35-dbcc-commands.md` | DBCC commands | |
| data compression, ROW compression, PAGE compression, COLUMNSTORE compression, sp_estimate_data_compression_savings | `references/36-data-compression.md` | Data compression | |
| CDC, Change Data Capture, Change Tracking, CT, ETL, cdc.fn_cdc_get_all_changes, CHANGETABLE | `references/37-change-tracking-cdc.md` | Change Tracking & CDC | |
| SQL Server Audit, SERVER AUDIT, audit specification, compliance, SOX, HIPAA, PCI-DSS, audit log | `references/38-auditing.md` | Auditing | |
| trigger, DML trigger, DDL trigger, logon trigger, AFTER, INSTEAD OF, inserted, deleted, COLUMNS_UPDATED | `references/39-triggers.md` | Triggers | |
| Service Broker, SSB, queue, SEND, RECEIVE, dialog conversation, activation, message type, contract, pub/sub | `references/40-service-broker-queuing.md` | Service Broker & queuing | |
| replication, snapshot replication, transactional replication, merge replication, publisher, distributor, subscriber, replication agent | `references/41-replication.md` | Replication | |
| database snapshot, AS SNAPSHOT OF, sparse file, REVERT, consistent read | `references/42-database-snapshots.md` | Database snapshots | |
| Always On, Availability Group, AG, listener, readable secondary, quorum, distributed AG, contained AG, log shipping, FCI, failover cluster | `references/43-high-availability.md` | High availability | |
| BACKUP, RESTORE, full backup, differential, log backup, tail log, point-in-time restore, NORECOVERY, STANDBY, S3 backup, backup encryption | `references/44-backup-restore.md` | Backup & restore | |
| linked server, four-part name, OPENQUERY, OPENDATASOURCE, distributed transaction, DTC | `references/45-linked-servers.md` | Linked servers | |
| PolyBase, external table, external data source, OPENROWSET, S3, Azure Blob, Hadoop, predicate pushdown | `references/46-polybase-external-tables.md` | PolyBase & external tables | |
| sqlcmd, bcp, sqlpackage, mssql-cli, BULK INSERT, OPENROWSET BULK, format file, dacpac, bacpac, PowerShell SQLServer | `references/47-cli-bulk-operations.md` | CLI & bulk operations | |
| Database Mail, sp_send_dbmail, mail profile, mail account, HTML mail, Agent alert notification | `references/48-database-mail.md` | Database Mail | |
| sp_configure, max server memory, MAXDOP, cost threshold, Resource Governor, trace flag, NUMA | `references/49-configuration-tuning.md` | Configuration & tuning | **MAXDOP**: here for server config; see also 32 for MAXDOP query hint |
| SQL Server Agent, job, job step, schedule, alert, operator, proxy, msdb, multi-server | `references/50-sql-server-agent.md` | SQL Server Agent | |
| SQL Server 2022, ledger 2022, S3 backup 2022, contained AG 2022, IS_DISTINCT_FROM, GREATEST, LEAST, XML compression | `references/51-2022-features.md` | SQL Server 2022 features | |
| SQL Server 2025, vector search, VECTOR type, vector index, AI features, 2025 T-SQL | `references/52-2025-features.md` | SQL Server 2025 features | |
| compatibility level, CE version, cardinality estimator, deprecated feature, upgrade, migration, contained database | `references/53-migration-compatibility.md` | Migration & compatibility | |
| SQL Server on Linux, Docker, mssql-conf, container, Pacemaker, mssql-tools, Linux limitations | `references/54-linux-containers.md` | Linux & containers | |


