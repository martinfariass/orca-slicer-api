# Print Farm Manager sidecar divergence

This branch is intentionally based on upstream `maziggy/orca-slicer-api`
branch `bambuddy/profile-resolver` at commit
`6b85ecc29344443149c86af1f53dbf1095017b74`. The runtime image inherits the
previously reviewed Bambu Studio image exactly:

`ghcr.io/maziggy/bambu-studio-api:bambuddy-1.2.5.5@sha256:e3579efbb568af19c337598853b828ffabd71b031c4180e6a2756377088a936b`

Only the Node API wrapper under `/app/dist` is replaced. The Bambu Studio
binary, profiles, libraries, operating-system packages, and Node dependencies
come from that immutable base image.

## Why this patch exists

The upstream wrapper creates and removes `/tmp/slice-*`, but Bambu Studio uses
`os.tmpdir()` independently and creates `/tmp/bamboo_model/...`, including
`lock.txt`, `_temp_*.config`, extracted model state, and empty directories.
Those paths therefore sit outside the directory removed by upstream after a
slice. Current upstream `main` and `bambuddy/profile-resolver` do not scope or
remove that private tree.

This patch gives every job a marked `/tmp/slice-*` lease and launches Bambu
Studio with `TMPDIR` set to an empty `runtime` directory inside that lease.
The existing whole-workspace lifecycle can then remove wrapper and Bambu
temporary state together after success, subprocess failure, profile failure,
client disconnect, or watchdog abort. The response file is opened first and
the workspace is removed before the terminal HTTP response is streamed.

At startup, only marked `slice-*` directories and the exact legacy
`bamboo_model` directory are eligible for cleanup. Recursive deletion rejects
root/outside paths, traversal, symlinks, unmarked directories, and
unrecognized names. A bounded tmpfs remains the primary crash boundary in the
PFM deployment.

The current PFM/Bambuddy architecture has no user-facing cancellation API.
Client disconnect and watchdog cancellation are supervised and tested; this
patch does not claim an unsupported explicit cancel operation.

## Reconciliation

Keep this change as a small derivative wrapper until equivalent behavior is
accepted upstream. When reconciling, compare lifecycle semantics and tests,
not just file names: success, failure, abort, stale startup recovery, capacity
rejection, and deletion boundaries must remain covered. Never rebase or move a
published PFM sidecar tag; publish a new immutable tag and digest instead.
