## Route Payload Options (`route.options.payload`)


Controls how the incoming request body is processed.

### All payload options


| Option               | Default              | Description                                                           |
| -------------------- | -------------------- | --------------------------------------------------------------------- |
| `allow`              | See below            | String or array of allowed MIME types.                                |
| `compression`        | none                 | Object of content-encoding decoders (keys are encoding names).        |
| `defaultContentType` | `'application/json'` | Assumed content type when `Content-Type` header is missing.           |
| `failAction`         | `'error'`            | How to handle payload parsing errors. `failAction` value.             |
| `maxBytes`           | `1048576` (1MB)      | Maximum payload size in bytes.                                        |
| `maxParts`           | `1000`               | Maximum number of parts in multipart payloads.                        |
| `multipart`          | `false`              | Multipart processing: `false`, `true`, or object with `output`.       |
| `output`             | `'data'`             | Payload format: `'data'`, `'stream'`, or `'file'`.                    |
| `override`           | none                 | MIME type string to override the received `Content-Type`.             |
| `parse`              | `true`               | `true`, `false`, or `'gunzip'`.                                       |
| `protoAction`        | `'error'`            | Prototype poisoning protection: `'error'`, `'remove'`, or `'ignore'`. |
| `timeout`            | `10000` (10s)        | Payload reception timeout in ms. `false` to disable.                  |
| `uploads`            | `os.tmpdir()`        | Directory for file uploads.                                           |

### `allow`


Default allowed MIME types:
- `application/json`
- `application/*+json`
- `application/octet-stream`
- `application/x-www-form-urlencoded`
- `multipart/form-data`
- `text/*`

Adding MIME types not in this list will NOT enable parsing for them. If `parse` is `true`, unrecognized types result in a 400 error.

    payload: {
        allow: ['application/json', 'application/x-www-form-urlencoded']
    }

### `output`


Controls how the payload is presented to the handler:

| Value      | Behavior                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `'data'`   | Payload is read into memory. If `parse: true`, it is parsed based on `Content-Type`. If `parse: false`, a raw `Buffer` is returned. |
| `'stream'` | Payload available as `Stream.Readable`. For multipart with `parse: true`, fields are text and files are streams.                    |
| `'file'`   | Payload written to a temp file in `uploads` directory. Application must clean up files.                                             |

    // Stream payload
    server.route({
        method: 'POST',
        path: '/upload',
        options: {
            payload: {
                output: 'stream',
                parse: true,
                multipart: true,
                maxBytes: 50 * 1024 * 1024
            },
            handler: async function (request, h) {

                const file = request.payload.file;
                // file is a Stream with file.hapi.filename and file.hapi.headers
                return 'uploaded';
            }
        }
    });

### `parse`


| Value      | Behavior                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `true`     | Parse payload based on `Content-Type` and `allow`. Unknown types return 400. Content encoding is decoded. |
| `false`    | Raw payload returned unmodified.                                                                          |
| `'gunzip'` | Raw payload returned after decoding any content encoding (e.g., gzip).                                    |

### `multipart`


| Value               | Behavior                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `false`             | Disable multipart processing (default).                                                                  |
| `true`              | Enable multipart processing using the route `output` setting.                                            |
| `{ output: '...' }` | Override output specifically for multipart. Supports `'data'`, `'stream'`, `'file'`, plus `'annotated'`. |

The `annotated` output wraps each multipart part in:

    {
        headers: { /* part headers */ },
        filename: 'file.txt',
        payload: /* processed part payload */
    }

### `protoAction` (prototype poisoning protection)


| Value      | Behavior                                                       |
| ---------- | -------------------------------------------------------------- |
| `'error'`  | Returns 400 when payload contains `__proto__` or similar.      |
| `'remove'` | Silently strips prototype properties from the payload.         |
| `'ignore'` | No protection. Only use when you are certain the data is safe. |

### Common patterns


**Large file upload:**

    server.route({
        method: 'POST',
        path: '/upload',
        options: {
            payload: {
                output: 'file',
                parse: true,
                multipart: true,
                maxBytes: 100 * 1024 * 1024,    // 100MB
                uploads: '/tmp/app-uploads'
            },
            handler: function (request, h) {

                // request.payload.file is the temp file path
                // MUST clean up files manually (listen to server 'response' event)
                return 'ok';
            }
        }
    });

**Raw binary payload:**

    server.route({
        method: 'POST',
        path: '/binary',
        options: {
            payload: {
                parse: false,
                maxBytes: 5 * 1024 * 1024
            },
            handler: function (request, h) {

                // request.payload is a Buffer
                return `Received ${request.payload.length} bytes`;
            }
        }
    });

**Accept only JSON:**

    server.route({
        method: 'POST',
        path: '/api/data',
        options: {
            payload: {
                allow: 'application/json',
                defaultContentType: 'application/json'
            },
            handler: (request, h) => request.payload
        }
    });

### Gotchas


- When `output` is `'file'`, the application is responsible for cleaning up temp files.
- Multipart file streams (with `output: 'stream'` and `parse: true`) are synthetic -- the entire multipart content is loaded into memory. To avoid this for large files, set `parse: false` and use a streaming parser like **pez**.
- `maxBytes` applies to the entire payload. Very large limits can cause out-of-memory issues.
- The `timeout` is for receiving the payload, not processing it. Set `route.options.timeout.server` for total request timeout.
- `compression` here configures **decoders** (for incoming payloads). Encoder settings go in `route.options.compression`.
