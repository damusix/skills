# SQL Server on Linux and Containers

Complete reference for running SQL Server on Linux, in Docker containers, and in
Kubernetes. Covers mssql-conf, Docker volume mounts, networking, Linux-specific
limitations, and HA with Pacemaker-based Availability Groups.

## Table of Contents

1. [When to Use](#when-to-use)
2. [Supported Linux Platforms](#supported-linux-platforms)
3. [Installation Overview](#installation-overview)
4. [mssql-conf Reference](#mssql-conf-reference)
5. [Key mssql-conf Settings](#key-mssql-conf-settings)
6. [Docker: Quick Start](#docker-quick-start)
7. [Docker: Environment Variables](#docker-environment-variables)
8. [Docker: Volume Mounts](#docker-volume-mounts)
9. [Docker: Networking and Ports](#docker-networking-and-ports)
10. [Docker: Multi-Container Compose](#docker-multi-container-compose)
11. [Container Initialization Scripts](#container-initialization-scripts)
12. [mssql-tools and PATH](#mssql-tools-and-path)
13. [Linux Limitations vs Windows](#linux-limitations-vs-windows)
14. [File System and Permissions](#file-system-and-permissions)
15. [Performance Tuning on Linux](#performance-tuning-on-linux)
16. [TLS/SSL Configuration](#tlsssl-configuration)
17. [Active Directory Authentication on Linux](#active-directory-authentication-on-linux)
18. [HA on Linux: Pacemaker-Based AGs](#ha-on-linux-pacemaker-based-ags)
19. [Kubernetes Deployment Patterns](#kubernetes-deployment-patterns)
20. [Monitoring and Diagnostics](#monitoring-and-diagnostics)
21. [Backup and Restore on Linux](#backup-and-restore-on-linux)
22. [Common Patterns](#common-patterns)
23. [Gotchas](#gotchas)
24. [See Also](#see-also)
25. [Sources](#sources)

---

## When to Use

Load this file when the user asks about:
- Running SQL Server on RHEL, Ubuntu, SLES, or other Linux distros
- SQL Server in Docker containers or Kubernetes
- `mssql-conf` settings and configuration
- `mssql-tools` CLI tools path and usage on Linux
- Linux-specific SQL Server limitations (no MSDTC, no FileStream, etc.)
- Always On AG with Pacemaker on Linux
- SQL Server Linux performance tuning
- Active Directory / Kerberos auth on Linux SQL Server

---

## Supported Linux Platforms

| Distro | SQL Server 2019 | SQL Server 2022 |
|--------|----------------|----------------|
| RHEL 8.x | ✓ | ✓ |
| RHEL 9.x | – | ✓ |
| Ubuntu 18.04 | ✓ | – |
| Ubuntu 20.04 | ✓ | ✓ |
| Ubuntu 22.04 | – | ✓ |
| SLES 12 SP5 | ✓ | ✓ |
| SLES 15 | ✓ | ✓ |

> [!NOTE] SQL Server 2022
> RHEL 9 and Ubuntu 22.04 support added in SQL Server 2022 CU 10 and later versions. [^9]

Minimum hardware:
- 2 GB RAM (8 GB recommended for production)
- 10 GB disk space
- x86-64 or ARM64 (limited platform support — check release notes)

---

## Installation Overview

```bash
# Ubuntu 22.04 example
curl https://packages.microsoft.com/keys/microsoft.asc | sudo apt-key add -
curl https://packages.microsoft.com/config/ubuntu/22.04/mssql-server-2022.list \
  | sudo tee /etc/apt/sources.list.d/mssql-server.list

sudo apt-get update
sudo apt-get install -y mssql-server

# Run setup wizard (sets SA password, edition, etc.)
sudo /opt/mssql/bin/mssql-conf setup

# Verify
systemctl status mssql-server

# Install mssql-tools (sqlcmd, bcp)
curl https://packages.microsoft.com/config/ubuntu/22.04/prod.list \
  | sudo tee /etc/apt/sources.list.d/msprod.list
sudo apt-get update
sudo apt-get install -y mssql-tools unixodbc-dev
echo 'export PATH="$PATH:/opt/mssql-tools/bin"' >> ~/.bashrc
source ~/.bashrc
```

---

## mssql-conf Reference

`mssql-conf` is the primary Linux configuration utility, replacing registry keys used on Windows. Settings are stored in `/var/opt/mssql/mssql.conf` (INI format).

```bash
# Get a setting
sudo /opt/mssql/bin/mssql-conf get sqlagent enabled

# Set a setting
sudo /opt/mssql/bin/mssql-conf set sqlagent.enabled true

# Bulk apply settings from stdin
sudo /opt/mssql/bin/mssql-conf set-collation SQL_Latin1_General_CP1_CI_AS

# View current configuration
cat /var/opt/mssql/mssql.conf

# Direct edit (requires service restart)
sudo nano /var/opt/mssql/mssql.conf
```

`/var/opt/mssql/mssql.conf` format:

```ini
[sqlagent]
enabled = true

[memory]
memorylimitmb = 4096

[network]
tcpport = 1433
tlsprotocols = 1.2
tlscert = /etc/ssl/certs/mssql.pem
tlskey = /etc/ssl/private/mssql.key

[EULA]
accepteula = Y

[coredump]
coredumptype = mini

[hadr]
hadrenabled = 1

[traceflag]
traceflag0 = 3226
traceflag1 = 1117
```

> [!WARNING] Service restart required
> Most mssql-conf changes require restarting the SQL Server service:
> `sudo systemctl restart mssql-server`

---

## Key mssql-conf Settings

### Memory

```bash
# Limit SQL Server memory (in MB) — critical on shared Linux hosts
sudo /opt/mssql/bin/mssql-conf set memory.memorylimitmb 4096
```

| Setting | Section | Description | Default |
|---------|---------|-------------|---------|
| `memorylimitmb` | `[memory]` | Max server memory in MB | Unlimited |
| `memorylimitmb` should leave 1–2 GB for OS | | | |

### Network

```bash
sudo /opt/mssql/bin/mssql-conf set network.tcpport 1433
sudo /opt/mssql/bin/mssql-conf set network.tlsprotocols 1.2
sudo /opt/mssql/bin/mssql-conf set network.tlscert /etc/ssl/certs/mssql.pem
sudo /opt/mssql/bin/mssql-conf set network.tlskey /etc/ssl/private/mssql.key
sudo /opt/mssql/bin/mssql-conf set network.forceencryption 1
```

### SQL Agent

```bash
sudo /opt/mssql/bin/mssql-conf set sqlagent.enabled true
# Restart required
sudo systemctl restart mssql-server
```

### HADR (Always On)

```bash
sudo /opt/mssql/bin/mssql-conf set hadr.hadrenabled 1
sudo systemctl restart mssql-server
```

### File Paths

```bash
# Move data, log, and backup default directories
sudo /opt/mssql/bin/mssql-conf set filelocation.defaultdatadir /mnt/data
sudo /opt/mssql/bin/mssql-conf set filelocation.defaultlogdir  /mnt/log
sudo /opt/mssql/bin/mssql-conf set filelocation.defaultbackupdir /mnt/backup
sudo /opt/mssql/bin/mssql-conf set filelocation.masterdatafile /mnt/data/master.mdf
sudo /opt/mssql/bin/mssql-conf set filelocation.masterlogfile /mnt/log/mastlog.ldf
```

> [!WARNING]
> Moving master database files requires careful procedure — the service must be
> pointed to the new paths before moving the files, or it will fail to start.
> Always test in a non-production environment first.

### Trace Flags

```bash
# Set trace flags (restarts automatically clear these unless in mssql.conf)
sudo /opt/mssql/bin/mssql-conf traceflag 3226 on   # suppress backup success messages
sudo /opt/mssql/bin/mssql-conf traceflag 1117 on   # uniform file growth (pre-2016 default)
```

### Collation

```bash
# Set server collation (destructive — wipes and recreates system DBs)
sudo /opt/mssql/bin/mssql-conf set-collation SQL_Latin1_General_CP1_CI_AS
```

> [!WARNING]
> `set-collation` destroys all system databases. Only run on fresh installs.

### Edition

```bash
# Set edition using PID (product key) or edition name
sudo /opt/mssql/bin/mssql-conf set-edition Enterprise
# Valid: Enterprise, Standard, Web, Developer, Express, Evaluation
```

### Core Dumps

```bash
sudo /opt/mssql/bin/mssql-conf set coredump.coredumptype full   # mini, full, filtered
sudo /opt/mssql/bin/mssql-conf set coredump.captureminiandfull true
```

### TempDB Configuration

```bash
# Set number of TempDB data files (default = 8, can be 1-128)
sudo /opt/mssql/bin/mssql-conf set sqltempdbfilecount 8
sudo /opt/mssql/bin/mssql-conf set sqltempdbfilesize 512       # initial size MB
sudo /opt/mssql/bin/mssql-conf set sqltempdbfilegrowth 64      # growth in MB
sudo /opt/mssql/bin/mssql-conf set sqltempdblogfilesize 128
sudo /opt/mssql/bin/mssql-conf set sqltempdblogfilegrowth 64
```

---

## Docker: Quick Start

```bash
# SQL Server 2022
docker run -e "ACCEPT_EULA=Y" \
           -e "MSSQL_SA_PASSWORD=YourStrong@Passw0rd" \
           -e "MSSQL_PID=Developer" \
           -p 1433:1433 \
           --name sql1 \
           --hostname sql1 \
           -d \
           mcr.microsoft.com/mssql/server:2022-latest

# Connect with sqlcmd inside the container
docker exec -it sql1 /opt/mssql-tools/bin/sqlcmd \
  -S localhost -U SA -P "YourStrong@Passw0rd"

# Or from the host if mssql-tools is installed
sqlcmd -S localhost,1433 -U SA -P "YourStrong@Passw0rd"
```

### Official Image Tags

| Tag | Description |
|-----|-------------|
| `2022-latest` | Latest SQL Server 2022 CU |
| `2022-CU12-ubuntu-22.04` | Specific CU on Ubuntu 22.04 |
| `2019-latest` | Latest SQL Server 2019 CU |
| `2022-preview` | Preview builds |

> [!NOTE]
> Always pin to a specific CU tag in production (`2022-CU12-ubuntu-22.04`), not
> `latest`, to ensure reproducible builds.

---

## Docker: Environment Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `ACCEPT_EULA` | Yes | Accept license agreement | `Y` |
| `MSSQL_SA_PASSWORD` | Yes (or `SA_PASSWORD`) | SA password (min 8 chars, complexity) | `MyP@ssw0rd` |
| `SA_PASSWORD` | Legacy | Alias for `MSSQL_SA_PASSWORD` | |
| `MSSQL_PID` | No | Edition or product key | `Developer`, `Express`, `Standard`, `Enterprise`, `Web`, `Evaluation` |
| `MSSQL_LCID` | No | Locale ID for collation | `1033` (en-US) |
| `MSSQL_COLLATION` | No | Server collation | `SQL_Latin1_General_CP1_CI_AS` |
| `MSSQL_MEMORY_LIMIT_MB` | No | Max server memory in MB | `4096` |
| `MSSQL_TCP_PORT` | No | TCP port inside container | `1433` |
| `MSSQL_IP_ADDRESS` | No | Bind address | `0.0.0.0` |
| `MSSQL_AGENT_ENABLED` | No | Enable SQL Agent | `true` |
| `MSSQL_ENABLE_HADR` | No | Enable HADR for AG support | `1` |
| `MSSQL_DATA_DIR` | No | Default data file path | `/var/opt/mssql/data` |
| `MSSQL_LOG_DIR` | No | Default log file path | `/var/opt/mssql/log` |
| `MSSQL_BACKUP_DIR` | No | Default backup path | `/var/opt/mssql/backup` |
| `TZ` | No | Container timezone (affects GETDATE()) | `America/New_York` |

> [!WARNING] SA_PASSWORD complexity
> The SA password must meet SQL Server complexity requirements: at least 8 chars,
> containing uppercase, lowercase, digit, and symbol. Weak passwords cause the
> container to start then immediately exit — check `docker logs sql1`.

---

## Docker: Volume Mounts

Without volume mounts, all data is lost when the container is removed.

```bash
# Create named volumes
docker volume create sqldata
docker volume create sqllog
docker volume create sqlbackup

# Run with volumes mounted
docker run -e "ACCEPT_EULA=Y" \
           -e "MSSQL_SA_PASSWORD=YourStrong@Passw0rd" \
           -p 1433:1433 \
           --name sql1 \
           -v sqldata:/var/opt/mssql/data \
           -v sqllog:/var/opt/mssql/log \
           -v sqlbackup:/var/opt/mssql/backup \
           -d mcr.microsoft.com/mssql/server:2022-latest

# Or bind-mount host directories
docker run -e "ACCEPT_EULA=Y" \
           -e "MSSQL_SA_PASSWORD=YourStrong@Passw0rd" \
           -p 1433:1433 \
           --name sql1 \
           -v /mnt/sqldata:/var/opt/mssql/data \
           -v /mnt/sqllog:/var/opt/mssql/log \
           -v /mnt/sqlbackup:/var/opt/mssql/backup \
           -d mcr.microsoft.com/mssql/server:2022-latest
```

> [!WARNING] File ownership
> SQL Server in the container runs as UID 10001 (`mssql` user). Host-mounted
> directories must be writable by UID 10001:
> ```bash
> sudo chown -R 10001:0 /mnt/sqldata /mnt/sqllog /mnt/sqlbackup
> ```
> Failure to set ownership causes SQL Server to fail to start or create databases.

### Default Container Paths

| Purpose | Container Path |
|---------|---------------|
| Data files (.mdf, .ndf) | `/var/opt/mssql/data/` |
| Log files (.ldf) | `/var/opt/mssql/log/` |
| Error log | `/var/opt/mssql/log/errorlog` |
| Backups | `/var/opt/mssql/backup/` |
| mssql.conf | `/var/opt/mssql/mssql.conf` |
| Secrets | `/var/opt/mssql/secrets/` |

---

## Docker: Networking and Ports

```bash
# Default: map container 1433 to host 1433
-p 1433:1433

# Named instance or alternate port (not a Windows-style named instance)
-p 1434:1433 -e MSSQL_TCP_PORT=1433

# Expose to localhost only (security best practice)
-p 127.0.0.1:1433:1433

# Multiple containers on same host — use different host ports
docker run ... -p 1434:1433 --name sql2 ...
docker run ... -p 1435:1433 --name sql3 ...

# Container-to-container (same network) — use container name as hostname
docker network create sqlnet
docker run ... --network sqlnet --name sql1 ...
# Connect from another container: Server=sql1,1433
```

> [!NOTE]
> SQL Server on Linux does not support named instances in the Windows sense
> (e.g., `HOSTNAME\INSTANCE`). Each instance is a separate process listening on
> a specific TCP port. Use port-based connection strings: `Server=host,1434`.

---

## Docker: Multi-Container Compose

```yaml
# docker-compose.yml
version: "3.8"
services:
  sqlserver:
    image: mcr.microsoft.com/mssql/server:2022-CU12-ubuntu-22.04
    container_name: sql1
    hostname: sql1
    environment:
      ACCEPT_EULA: "Y"
      MSSQL_SA_PASSWORD: "${SA_PASSWORD}"
      MSSQL_PID: "Developer"
      MSSQL_AGENT_ENABLED: "true"
      MSSQL_MEMORY_LIMIT_MB: "4096"
    ports:
      - "127.0.0.1:1433:1433"
    volumes:
      - sqldata:/var/opt/mssql/data
      - sqllog:/var/opt/mssql/log
      - sqlbackup:/var/opt/mssql/backup
      - ./init:/docker-entrypoint-initdb.d   # custom init scripts
    healthcheck:
      test: /opt/mssql-tools/bin/sqlcmd -S localhost -U SA -P "$$MSSQL_SA_PASSWORD"
             -Q "SELECT 1" -b -o /dev/null
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s
    restart: unless-stopped

volumes:
  sqldata:
  sqllog:
  sqlbackup:
```

```bash
# .env file (never commit to source control)
SA_PASSWORD=YourStrong@Passw0rd

# Start
docker compose up -d

# View logs
docker compose logs -f sqlserver
```

---

## Container Initialization Scripts

The official SQL Server container image does not have a built-in init script
mechanism like Postgres. Use a wrapper approach:

```bash
#!/bin/bash
# entrypoint.sh — run alongside sqlservr
set -e

# Wait for SQL Server to be ready
wait_for_sql() {
  local -r max_attempts=30
  local attempt=1
  while ! /opt/mssql-tools/bin/sqlcmd \
    -S localhost -U SA -P "$MSSQL_SA_PASSWORD" \
    -Q "SELECT 1" -b -o /dev/null 2>/dev/null; do
    echo "Waiting for SQL Server... attempt $attempt/$max_attempts"
    sleep 2
    ((attempt++))
    if [[ $attempt -gt $max_attempts ]]; then
      echo "SQL Server failed to start" >&2
      exit 1
    fi
  done
  echo "SQL Server is ready."
}

# Start SQL Server in background
/opt/mssql/bin/sqlservr &
SQL_PID=$!

wait_for_sql

# Run init scripts
for f in /docker-entrypoint-initdb.d/*.sql; do
  echo "Running $f..."
  /opt/mssql-tools/bin/sqlcmd \
    -S localhost -U SA -P "$MSSQL_SA_PASSWORD" \
    -i "$f" -b
done

# Wait for SQL Server process
wait $SQL_PID
```

```dockerfile
FROM mcr.microsoft.com/mssql/server:2022-latest
COPY entrypoint.sh /
COPY init/*.sql /docker-entrypoint-initdb.d/
RUN chmod +x /entrypoint.sh
CMD ["/entrypoint.sh"]
```

---

## mssql-tools and PATH

```bash
# mssql-tools installs sqlcmd and bcp to:
/opt/mssql-tools/bin/sqlcmd
/opt/mssql-tools/bin/bcp

# Add to PATH permanently
echo 'export PATH="$PATH:/opt/mssql-tools/bin"' >> ~/.bashrc
source ~/.bashrc

# Or for all users
echo 'export PATH="$PATH:/opt/mssql-tools/bin"' | \
  sudo tee /etc/profile.d/mssql-tools.sh

# Newer mssql-tools18 path (2022+ packages)
/opt/mssql-tools18/bin/sqlcmd
```

> [!NOTE] mssql-tools18
> SQL Server 2022 ships with `mssql-tools18` (using ODBC Driver 18) which
> enforces TLS encryption by default. Connection strings may need
> `-N` (encrypt) and `-C` (trust server certificate) flags:
> ```bash
> sqlcmd -S localhost -U SA -P "$SA_PASSWORD" -N -C
> ```

### sqlcmd Quick Reference on Linux

```bash
# Interactive session
sqlcmd -S localhost -U SA -P "MyPass" -d MyDatabase

# Run a script
sqlcmd -S localhost -U SA -P "MyPass" -i /path/to/script.sql -o /path/to/output.log -b

# One-liner query
sqlcmd -S localhost -U SA -P "MyPass" -Q "SELECT @@VERSION" -h -1 -W

# With variable substitution
sqlcmd -S localhost -U SA -P "MyPass" \
  -v DbName="Production" \
  -i deploy.sql

# Using Kerberos (AD auth)
sqlcmd -S hostname.domain.com -E    # -E = trusted connection / AD auth
```

---

## Linux Limitations vs Windows

### Features Not Available on Linux

| Feature | Status | Notes / Alternative |
|---------|--------|-------------------|
| MSDTC (Distributed Transactions) | Limited | Available from SQL Server 2017 CU 16+ with configuration; not default [^10] |
| FileStream | Not supported | Use FILESTREAM alternatives or store BLOBs externally |
| FileTable | Not supported | Depends on FileStream |
| Windows Authentication (Kerberos) | Supported with setup | Requires `adutil`, keytab, and `/etc/krb5.conf` configuration |
| SQL Server Browser | Not available | Not needed — use explicit port connections |
| Named instances | Not supported | Use port-based connections instead |
| Machine Learning Services (R/Python) | Supported | Separate package install required |
| PolyBase | Supported | Additional configuration needed |
| Full-Text Search | Supported | `mssql-server-fts` package required |
| SQL Server Reporting Services | Not supported | Use Windows host or Power BI Report Server |
| SQL Server Analysis Services | Not supported | Windows only |
| SQL Server Integration Services | Supported | `mssql-server-is` package, Linux-compatible packages only |
| ActiveX scripting job steps | Not supported | Deprecated feature |
| Replication | Supported | Transactional, snapshot (not merge in all versions) |
| Database Mirroring | Not supported | Deprecated; use Always On AG |
| Log Shipping | Supported | Full support |
| Backup to tape | Not supported | Use disk or S3/Azure Blob |
| WMI Provider | Not supported | Use T-SQL or PowerShell alternatives |

### Features Available but Different

| Feature | Linux Difference |
|---------|-----------------|
| SQL Server Agent | Runs as separate `mssqlagent` process; enabled via mssql-conf |
| Event Viewer / Windows Event Log | Logs go to syslog or journald; read with `journalctl -u mssql-server` |
| Perfmon counters | Use `sys.dm_os_performance_counters` or `collectd` |
| Windows ACLs | Use Linux file permissions; SQL Server runs as `mssql` user |
| TempDB | Uses tmpfs if configured; same behavior otherwise |
| Case sensitivity | Filesystem is case-sensitive on Linux — script filenames carefully |

---

## File System and Permissions

SQL Server on Linux runs as the `mssql` system user (UID 10001 in containers).
All data directories must be owned by this user.

```bash
# Check current ownership
ls -la /var/opt/mssql/

# Fix permissions for custom directories
sudo chown -R mssql:mssql /mnt/sqldata /mnt/sqllog /mnt/sqlbackup
sudo chmod 700 /mnt/sqldata /mnt/sqllog /mnt/sqlbackup

# In Docker: UID 10001 maps to mssql inside container
sudo chown -R 10001:0 /mnt/sqldata
sudo chmod -R 770 /mnt/sqldata
```

### Recommended File System Choices

| Filesystem | Data Files | Notes |
|------------|------------|-------|
| XFS | ✓ Preferred | Best performance, supports sparse files for snapshots |
| ext4 | ✓ Good | Solid choice, slightly lower throughput than XFS |
| tmpfs | TempDB only | Memory-backed; fast but volatile |
| NFS | ✗ Avoid | High latency; not supported for SQL Server data files |
| CIFS/SMB | ✗ Avoid | Not supported |
| Azure Premium SSD | ✓ | For Azure VMs; use P30+ for data |
| io_uring | 2022+ | Async I/O interface on newer Linux kernels; no SQL Server-specific documentation confirms native io_uring integration |

```bash
# Check filesystem type
df -T /var/opt/mssql/

# Recommended mount options for XFS (in /etc/fstab)
# noatime reduces unnecessary metadata writes
/dev/sdb1  /mnt/sqldata  xfs  defaults,noatime  0  2
```

---

## Performance Tuning on Linux

### Huge Pages / Transparent Huge Pages

```bash
# Check THP status
cat /sys/kernel/mm/transparent_hugepage/enabled
# Output: always [madvise] never
# SQL Server prefers: madvise (allows SQL Server to request THPs selectively)

# Set madvise
echo madvise | sudo tee /sys/kernel/mm/transparent_hugepage/enabled

# Make permanent (RHEL/CentOS via grub, Ubuntu via rc.local or systemd)
# Add to /etc/rc.local:
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
```

### Swappiness

```bash
# SQL Server needs predictable memory — reduce swappiness
echo 10 | sudo tee /proc/sys/vm/swappiness

# Permanent: add to /etc/sysctl.conf
vm.swappiness = 10
```

### CPU Scheduler

```bash
# Use performance CPU governor (not powersave)
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  echo performance | sudo tee "$cpu"
done
```

### Open Files Limit

```bash
# SQL Server may need many file descriptors; check limits
cat /proc/$(pgrep sqlservr)/limits | grep "Open files"

# Increase in /etc/security/limits.conf
mssql soft nofile 65536
mssql hard nofile 65536
```

### NUMA Topology

```bash
# Verify NUMA nodes
numactl --hardware

# SQL Server automatically detects and uses NUMA on Linux (same as Windows)
# Check via DMV
SELECT scheduler_id, cpu_id, node_id, status
FROM sys.dm_os_schedulers
WHERE status = 'VISIBLE ONLINE';
```

---

## TLS/SSL Configuration

```bash
# Generate self-signed cert (dev/test only)
openssl req -x509 -nodes -newkey rsa:2048 \
  -subj "/CN=$(hostname)" \
  -keyout /etc/ssl/private/mssql.key \
  -out /etc/ssl/certs/mssql.pem \
  -days 365

# Set ownership
sudo chown mssql:mssql /etc/ssl/private/mssql.key /etc/ssl/certs/mssql.pem
sudo chmod 600 /etc/ssl/private/mssql.key

# Configure via mssql-conf
sudo /opt/mssql/bin/mssql-conf set network.tlscert /etc/ssl/certs/mssql.pem
sudo /opt/mssql/bin/mssql-conf set network.tlskey  /etc/ssl/private/mssql.key
sudo /opt/mssql/bin/mssql-conf set network.tlsprotocols 1.2,1.3
sudo /opt/mssql/bin/mssql-conf set network.forceencryption 1
sudo systemctl restart mssql-server
```

> [!NOTE] mssql-tools18 defaults
> `mssql-tools18` enables encryption by default. When connecting to a server
> with a self-signed cert, trust it explicitly:
> ```bash
> sqlcmd -S server -U SA -P pass -N -C   # -C = TrustServerCertificate
> ```

---

## Active Directory Authentication on Linux

SQL Server 2019+ supports Windows Authentication on Linux via Kerberos.

```bash
# Install adutil (Microsoft's AD integration tool)
# RHEL/CentOS:
sudo yum install -y adutil

# Join the domain (using realm or sssd)
sudo realm join --user=Administrator CONTOSO.COM

# Create SQL Server AD user and SPN
adutil user create --name sqluser --password 'P@ssw0rd' --ou 'OU=Service Accounts,DC=contoso,DC=com'
adutil spn createauto -n sqluser -s MSSQLSvc -H sql-linux.contoso.com -p 1433 -P 'P@ssw0rd'

# Create keytab
adutil keytab createauto -k /var/opt/mssql/secrets/mssql.keytab \
  -p 1433 -H sql-linux.contoso.com -P 'P@ssw0rd' -s MSSQLSvc

# Configure SQL Server to use keytab
sudo /opt/mssql/bin/mssql-conf set network.kerberoskeytabfile \
  /var/opt/mssql/secrets/mssql.keytab
sudo systemctl restart mssql-server

# Connect with Windows Authentication from Linux client
sqlcmd -S sql-linux.contoso.com -E    # requires kinit first
```

```bash
# Test Kerberos ticket
kinit administrator@CONTOSO.COM
klist    # verify ticket
sqlcmd -S sql-linux.contoso.com -E
```

---

## HA on Linux: Pacemaker-Based AGs

Always On AGs on Linux use Pacemaker + Corosync instead of Windows Server Failover Clustering (WSFC).

> [!NOTE] SQL Server 2017+
> Pacemaker-based AG support introduced in SQL Server 2017 on Linux. [^4]

### Architecture Comparison

| Aspect | Windows (WSFC) | Linux (Pacemaker) |
|--------|---------------|------------------|
| Cluster software | Windows Server Failover Clustering | Pacemaker + Corosync |
| Quorum | Windows quorum | Corosync/CMAN quorum |
| Resource agent | Built-in | `mssql-server-ha` package |
| Health monitoring | Windows Health Service | Pacemaker health agent |
| Virtual IP | Windows Cluster IP | Pacemaker IPaddr2 resource |
| Fencing | Windows storage fencing | SBD (Storage-Based Death) or IPMI |
| External cluster only | No | Yes (CLUSTER_TYPE=EXTERNAL) |

### Cluster Types

| `CLUSTER_TYPE` | When to use |
|---------------|-------------|
| `WSFC` | Windows Server Failover Clustering |
| `EXTERNAL` | Linux Pacemaker (automatic failover supported) |
| `NONE` | No cluster manager; manual failover only (read-scale AGs) |

### Setup Steps (High Level)

```bash
# 1. Enable HADR on each node
sudo /opt/mssql/bin/mssql-conf set hadr.hadrenabled 1
sudo systemctl restart mssql-server

# 2. Install Pacemaker packages (RHEL)
sudo yum install -y pacemaker pcs fence-agents-all

# 3. Install SQL Server HA extension
sudo yum install -y mssql-server-ha

# 4. Configure Pacemaker cluster
sudo pcs cluster auth node1 node2 node3 -u hacluster -p hapassword
sudo pcs cluster setup --name sqlcluster node1 node2 node3
sudo pcs cluster start --all
sudo pcs cluster enable --all

# 5. Disable STONITH (fencing) for testing only — ENABLE in production
sudo pcs property set stonith-enabled=false   # NOT for production

# 6. Create AG via T-SQL (CLUSTER_TYPE = EXTERNAL)
# (run on primary node)
```

```sql
-- Step 6: Create AG on primary (Linux Pacemaker)
CREATE AVAILABILITY GROUP [ag1]
WITH (CLUSTER_TYPE = EXTERNAL)
FOR REPLICA ON
  N'node1' WITH (
    ENDPOINT_URL = N'tcp://node1:5022',
    AVAILABILITY_MODE = SYNCHRONOUS_COMMIT,
    FAILOVER_MODE = EXTERNAL,
    SEEDING_MODE = AUTOMATIC
  ),
  N'node2' WITH (
    ENDPOINT_URL = N'tcp://node2:5022',
    AVAILABILITY_MODE = SYNCHRONOUS_COMMIT,
    FAILOVER_MODE = EXTERNAL,
    SEEDING_MODE = AUTOMATIC
  );
GO

-- Grant cluster permissions
GRANT ALTER, CONTROL, VIEW DEFINITION
  ON AVAILABILITY GROUP::ag1 TO [NT AUTHORITY\SYSTEM];
GRANT VIEW SERVER STATE TO [NT AUTHORITY\SYSTEM];
```

```sql
-- Run on secondaries
ALTER AVAILABILITY GROUP [ag1] JOIN WITH (CLUSTER_TYPE = EXTERNAL);
ALTER AVAILABILITY GROUP [ag1] GRANT CREATE ANY DATABASE;
```

```bash
# 7. Register AG as Pacemaker resource
sudo pcs resource create ag1 ocf:mssql:ag ag_name=ag1 \
  meta failure-timeout=60s \
  op start timeout=60s \
  op stop timeout=60s \
  op promote timeout=60s \
  op demote timeout=60s \
  op monitor timeout=60s interval=10s \
  op monitor timeout=60s interval=11s role="Master" \
  op monitor timeout=60s interval=12s role="Slave"

sudo pcs resource master ag1-master ag1 master-max=1 master-node-max=1 \
  clone-max=3 clone-node-max=1 notify=true

# 8. Configure virtual IP resource
sudo pcs resource create virtualip ocf:heartbeat:IPaddr2 ip=192.168.1.100 \
  cidr_netmask=24 op monitor interval=30s

# 9. Colocation and ordering constraints
sudo pcs constraint colocation add virtualip ag1-master INFINITY with-rsc-role=Master
sudo pcs constraint order promote ag1-master then start virtualip
```

### Read-Scale AG (No Cluster Manager)

```sql
-- For read-scale only (Linux or Windows), no automatic failover
CREATE AVAILABILITY GROUP [read_ag]
WITH (CLUSTER_TYPE = NONE)
FOR REPLICA ON
  N'primary' WITH (
    ENDPOINT_URL = N'tcp://primary:5022',
    AVAILABILITY_MODE = ASYNCHRONOUS_COMMIT,
    FAILOVER_MODE = MANUAL,
    SEEDING_MODE = AUTOMATIC
  ),
  N'secondary' WITH (
    ENDPOINT_URL = N'tcp://secondary:5022',
    AVAILABILITY_MODE = ASYNCHRONOUS_COMMIT,
    FAILOVER_MODE = MANUAL,
    SEEDING_MODE = AUTOMATIC
  );
```

---

## Kubernetes Deployment Patterns

> [!WARNING]
> SQL Server is stateful — production K8s deployments require careful storage
> class configuration. Use this as a starting point, not a production blueprint.

```yaml
# StatefulSet example (simplified — not production-ready)
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mssql
spec:
  serviceName: mssql
  replicas: 1
  selector:
    matchLabels:
      app: mssql
  template:
    metadata:
      labels:
        app: mssql
    spec:
      containers:
      - name: mssql
        image: mcr.microsoft.com/mssql/server:2022-latest
        ports:
        - containerPort: 1433
        env:
        - name: ACCEPT_EULA
          value: "Y"
        - name: MSSQL_SA_PASSWORD
          valueFrom:
            secretKeyRef:
              name: mssql-secret
              key: sa-password
        - name: MSSQL_PID
          value: "Developer"
        - name: MSSQL_MEMORY_LIMIT_MB
          value: "4096"
        volumeMounts:
        - name: mssqldb
          mountPath: /var/opt/mssql
        livenessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - /opt/mssql-tools/bin/sqlcmd -S localhost
              -U SA -P "$MSSQL_SA_PASSWORD" -Q "SELECT 1" -b
          initialDelaySeconds: 30
          periodSeconds: 15
        readinessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - /opt/mssql-tools/bin/sqlcmd -S localhost
              -U SA -P "$MSSQL_SA_PASSWORD" -Q "SELECT 1" -b
          initialDelaySeconds: 10
          periodSeconds: 10
  volumeClaimTemplates:
  - metadata:
      name: mssqldb
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: "premium-ssd"    # use fast storage class
      resources:
        requests:
          storage: 100Gi
---
apiVersion: v1
kind: Service
metadata:
  name: mssql
spec:
  selector:
    app: mssql
  ports:
  - port: 1433
    targetPort: 1433
  type: ClusterIP
```

```bash
# Create secret for SA password
kubectl create secret generic mssql-secret \
  --from-literal=sa-password='YourStrong@Passw0rd'
```

> [!NOTE]
> For production K8s deployments consider using the
> [SQL Server Operator for Kubernetes](https://github.com/microsoft/mssql-operator)
> (preview) or deploy SQL Server on Azure SQL Managed Instance for Kubernetes
> (Arc-enabled SQL MI). [^11]

---

## Monitoring and Diagnostics

### Log Locations

```bash
# Error log (most important)
cat /var/opt/mssql/log/errorlog
tail -f /var/opt/mssql/log/errorlog

# systemd journal
journalctl -u mssql-server -f
journalctl -u mssql-server --since "1 hour ago"

# SQL Agent log
cat /var/opt/mssql/log/sqlagent.out

# Dump files (crashes)
ls /var/opt/mssql/log/*.mdmp
ls /var/opt/mssql/log/*.log
```

### DMV Diagnostics (same as Windows)

```sql
-- Check SQL Server version and platform
SELECT @@VERSION;
SELECT SERVERPROPERTY('Platform');   -- 'Linux'
SELECT SERVERPROPERTY('Edition');

-- OS-level metrics
SELECT physical_memory_in_use_kb, page_fault_count
FROM sys.dm_os_process_memory;

-- Scheduler/CPU
SELECT scheduler_id, cpu_id, node_id, status, is_online
FROM sys.dm_os_schedulers
WHERE status = 'VISIBLE ONLINE';

-- I/O by file
SELECT DB_NAME(database_id) AS db,
       physical_name,
       io_stall_read_ms / NULLIF(num_of_reads, 0) AS avg_read_ms,
       io_stall_write_ms / NULLIF(num_of_writes, 0) AS avg_write_ms
FROM sys.dm_io_virtual_file_stats(NULL, NULL) f
JOIN sys.master_files mf ON f.database_id = mf.database_id
                         AND f.file_id = mf.file_id
ORDER BY io_stall_read_ms + io_stall_write_ms DESC;
```

### Crash Dump Configuration

```bash
# Configure automatic crash dumps
sudo /opt/mssql/bin/mssql-conf set coredump.coredumptype filtered
sudo /opt/mssql/bin/mssql-conf set coredump.captureminiandfull true

# Location of dump files
ls /var/opt/mssql/log/*.mdmp

# Send dump to Microsoft Support
# Use mssqlsupport tool (must be installed separately)
```

---

## Backup and Restore on Linux

Backup and restore T-SQL syntax is identical to Windows. Key differences:

```bash
# Paths use forward slashes
BACKUP DATABASE MyDB
  TO DISK = '/var/opt/mssql/backup/MyDB.bak'
  WITH FORMAT, COMPRESSION, STATS = 10;

RESTORE DATABASE MyDB
  FROM DISK = '/var/opt/mssql/backup/MyDB.bak'
  WITH MOVE 'MyDB'     TO '/var/opt/mssql/data/MyDB.mdf',
       MOVE 'MyDB_log' TO '/var/opt/mssql/log/MyDB_log.ldf',
       RECOVERY;
```

```bash
# Shell-level backup via sqlcmd
sqlcmd -S localhost -U SA -P "$SA_PASSWORD" -Q \
  "BACKUP DATABASE [MyDB] TO DISK='/var/opt/mssql/backup/MyDB_$(date +%Y%m%d).bak'
   WITH FORMAT, COMPRESSION"

# Copy backup out of container
docker cp sql1:/var/opt/mssql/backup/MyDB.bak ./MyDB.bak

# Copy backup into container
docker cp ./MyDB.bak sql1:/var/opt/mssql/backup/MyDB.bak
```

> [!NOTE] SQL Server 2022 — S3-Compatible Backup
> S3-compatible backup works identically on Linux and Windows:
> ```sql
> BACKUP DATABASE MyDB
>   TO URL = 's3://bucket/path/MyDB.bak'
>   WITH FORMAT, COMPRESSION;
> ```
> See `references/44-backup-restore.md` for full S3 backup coverage.

### Cross-Platform Restore Considerations

| Scenario | Supported | Notes |
|----------|----------|-------|
| Windows backup → Linux restore | ✓ Yes | Full support for SQL Server 2017+ |
| Linux backup → Windows restore | ✓ Yes | Full support |
| Cross-version restore | Partial | Can only restore to same or newer version |
| FileStream database | ✗ No | FileStream not supported on Linux |

---

## Common Patterns

### Pattern 1: CI/CD Database Deployment with Docker

```bash
#!/bin/bash
# deploy-test.sh — spin up SQL Server, run migrations, run tests, tear down

set -e

SA_PASSWORD="TestP@ssw0rd$(date +%s)"

# Start SQL Server
docker run -d --name ci-sql \
  -e ACCEPT_EULA=Y \
  -e MSSQL_SA_PASSWORD="$SA_PASSWORD" \
  -e MSSQL_PID=Developer \
  -p 1433:1433 \
  mcr.microsoft.com/mssql/server:2022-latest

# Wait for readiness
until docker exec ci-sql /opt/mssql-tools/bin/sqlcmd \
  -S localhost -U SA -P "$SA_PASSWORD" -Q "SELECT 1" -b -o /dev/null 2>/dev/null; do
  sleep 2
done

# Run migrations
sqlpackage /Action:Publish \
  /SourceFile:./database.dacpac \
  /TargetServerName:localhost \
  /TargetDatabaseName:AppDb \
  /TargetUser:SA \
  /TargetPassword:"$SA_PASSWORD"

# Run integration tests
dotnet test --filter Category=Integration

# Cleanup
docker rm -f ci-sql
```

### Pattern 2: Scheduled Backup via Cron (No SQL Agent)

```bash
#!/bin/bash
# /usr/local/bin/sql-backup.sh
SA_PASSWORD=$(cat /etc/sqlsecret/sa-password)
BACKUP_DIR="/mnt/backup"
DB_LIST=$(sqlcmd -S localhost -U SA -P "$SA_PASSWORD" -h -1 -W \
  -Q "SET NOCOUNT ON; SELECT name FROM sys.databases WHERE database_id > 4")

for DB in $DB_LIST; do
  FILENAME="$BACKUP_DIR/${DB}_$(date +%Y%m%d_%H%M%S).bak"
  sqlcmd -S localhost -U SA -P "$SA_PASSWORD" -Q \
    "BACKUP DATABASE [$DB] TO DISK='$FILENAME' WITH FORMAT, COMPRESSION, STATS=25"
done

# Crontab: 2 AM daily
# 0 2 * * * /usr/local/bin/sql-backup.sh >> /var/log/sql-backup.log 2>&1
```

### Pattern 3: Health Check Endpoint

```bash
#!/bin/bash
# health-check.sh — return 0 if SQL Server is healthy, 1 otherwise
/opt/mssql-tools/bin/sqlcmd \
  -S localhost -U SA -P "$MSSQL_SA_PASSWORD" \
  -Q "SELECT 1" -b -o /dev/null 2>/dev/null
exit $?
```

### Pattern 4: mssql.conf Template for Production Linux

```ini
[EULA]
accepteula = Y

[memory]
memorylimitmb = 28672    # Leave ~4 GB for OS on 32 GB host

[network]
tcpport = 1433
forceencryption = 1
tlsprotocols = 1.2,1.3
tlscert = /etc/ssl/certs/mssql.pem
tlskey = /etc/ssl/private/mssql.key

[sqlagent]
enabled = true

[hadr]
hadrenabled = 0    # Set to 1 for AG members

[coredump]
coredumptype = filtered
captureminiandfull = true

[traceflag]
traceflag0 = 3226    # Suppress successful backup log messages

[filelocation]
defaultdatadir = /mnt/data
defaultlogdir = /mnt/log
defaultbackupdir = /mnt/backup
```

---

## Gotchas

1. **`latest` image tag moves** — always pin to a specific CU tag
   (e.g., `2022-CU12-ubuntu-22.04`) in production. `latest` can unexpectedly
   pick up a new CU on `docker pull`.

2. **UID 10001 in containers** — the `mssql` user inside the container is UID
   10001. Host-mounted volumes must be owned by UID 10001 (`chown -R 10001:0`).
   Forgetting this is the #1 cause of "container exits immediately" issues.

3. **mssql-conf changes need restarts** — most settings require
   `sudo systemctl restart mssql-server`. Editing `/var/opt/mssql/mssql.conf`
   directly has the same requirement.

4. **No named instances** — connect by port, not `HOST\INSTANCE`. Use
   `Server=host,port` in connection strings.

5. **Case-sensitive filesystem** — Linux filesystems (ext4, XFS) are
   case-sensitive. `.sql` script filenames, paths in T-SQL, and init script
   names must match exactly. Windows backup file extensions `.BAK` and `.bak`
   are different filenames on Linux.

6. **TLS by default in mssql-tools18** — `sqlcmd` from `mssql-tools18` requires
   encryption. Self-signed certs need `-C` (trust server certificate) or
   configure a proper cert. Older scripts using `mssql-tools` (without 18) may
   not encrypt by default.

7. **FileStream databases cannot be restored on Linux** — attempting to restore
   a FileStream-enabled database will fail. Must disable FileStream on Windows
   before migrating.

8. **MSDTC requires explicit configuration** — distributed transactions across
   SQL Server on Linux require setting up MSDTC (available from SQL Server 2017 CU 16+).
   Not enabled or installed by default. [^10]

9. **SQL Server Browser not available** — without SQL Server Browser, connections
   must specify the port explicitly. Dynamic port discovery (used by Windows
   clients when connecting to named instances) does not work.

10. **Pacemaker fencing is mandatory in production** — running Pacemaker AGs
    without STONITH/fencing enabled (`stonith-enabled=false`) is only acceptable
    in test environments. In production, split-brain scenarios without fencing
    can result in data corruption or dual-primary situations.

11. **Container TZ affects GETDATE()** — if the container timezone (`TZ`
    environment variable) differs from expectations, `GETDATE()` will return a
    different local time. Use `GETUTCDATE()` or `SYSUTCDATETIME()` for
    consistency, or set `TZ=UTC` on the container.

12. **Set `memorylimitmb` on shared hosts** — without this setting, SQL Server
    claims as much memory as possible, crowding out the OS and other processes.
    Always set `memory.memorylimitmb` on Linux hosts that share memory with
    other processes.

---

## See Also

- `references/43-high-availability.md` — Always On AG architecture details
- `references/44-backup-restore.md` — Backup/restore including S3 (2022+)
- `references/49-configuration-tuning.md` — sp_configure and server tuning
- `references/47-cli-bulk-operations.md` — sqlcmd, bcp, sqlpackage CLI tools
- `references/15-principals-permissions.md` — logins, users, permissions
- `references/16-security-encryption.md` — TLS/TDE/Always Encrypted

---

## Sources

[^1]: [Installation Guidance for SQL Server on Linux](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-setup) — covers supported platforms, system requirements, installation, update, and uninstall procedures for SQL Server on Linux
[^2]: [Configure SQL Server Settings on Linux](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-configure-mssql-conf) — full mssql-conf reference covering all configurable settings stored in mssql.conf
[^3]: [Docker: Run Containers for SQL Server on Linux](https://learn.microsoft.com/en-us/sql/linux/quickstart-install-connect-docker) — quickstart for running SQL Server Linux container images with Docker, including environment variables and volume mounts
[^4]: [Availability Groups for SQL Server on Linux](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-availability-group-overview) — overview of Always On availability group characteristics and differences between Linux (Pacemaker) and Windows (WSFC) deployments
[^5]: [Configure a Pacemaker Cluster for SQL Server Availability Groups](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-availability-group-cluster-pacemaker) — step-by-step guide for creating a Pacemaker cluster and adding an availability group resource on RHEL, SUSE, or Ubuntu
[^6]: [Editions and Supported Features of SQL Server 2022 - Linux](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-editions-and-components-2022) — lists features supported by each SQL Server 2022 edition on Linux and unsupported features and services
[^7]: [Configure Active Directory Authentication with SQL Server on Linux Using adutil](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-ad-auth-adutil-tutorial) — tutorial for setting up Kerberos-based Windows Authentication on Linux SQL Server using the adutil tool
[^8]: [Deploy and Connect to SQL Server Linux Containers](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-docker-container-deployment) — pulling images from Microsoft Container Registry (mcr.microsoft.com), running production editions, version management, and multi-container deployments
[^9]: [What's New for SQL Server 2022 on Linux](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-whats-new-2022) — RHEL 9 and Ubuntu 22.04 support (CU 10+), SLES 15 SP4 support (CU 4+), and other SQL Server 2022 Linux-specific updates
[^10]: [How to Configure MSDTC on Linux](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-configure-msdtc) — MSDTC configuration on Linux including RPC endpoint mapping, firewall rules, and port routing; supported from SQL Server 2017 CU 16+
[^11]: [Create a SQL Managed Instance Enabled by Azure Arc](https://learn.microsoft.com/en-us/azure/azure-arc/data/create-sql-managed-instance) — deploying Arc-enabled SQL Managed Instance on Kubernetes using Azure CLI and arcdata extension
