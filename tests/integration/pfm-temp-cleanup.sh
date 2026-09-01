#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# == 1 ]] || { echo "usage: $0 IMAGE" >&2; exit 2; }
image=$1
container="pfm-cleanup-integration-$$"
work=$(mktemp -d /tmp/pfm-cleanup-integration.XXXXXX)
port=39011

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if (( status != 0 )); then
    docker logs "$container" >&2 2>/dev/null || true
    for artifact in "$work"/failure.json; do
      [[ -f $artifact ]] || continue
      echo "--- failure response: $artifact" >&2
      head -c 4096 "$artifact" >&2 || true
      echo >&2
    done
  fi
  docker stop --timeout 3 "$container" >/dev/null 2>&1 || true
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT INT TERM

docker run -d --rm \
  --name "$container" \
  --platform linux/amd64 \
  --publish "127.0.0.1:${port}:3000" \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=1536m \
  --mount "type=bind,src=$work,dst=/app/data" \
  --env SLICER_MIN_TEMP_FREE_MB=16 \
  --env SLICER_TEMP_SPACE_FACTOR=3 \
  "$image" >/dev/null

for _attempt in {1..90}; do
  curl --fail --silent --max-time 3 "http://127.0.0.1:${port}/health" >/dev/null && break
  sleep 1
done
curl --fail --silent "http://127.0.0.1:${port}/health" | jq -e '.status == "healthy"' >/dev/null

curl --fail --silent "http://127.0.0.1:${port}/profiles/bundled" --output "$work/bundled.json"
printer=$(jq -r '.printer[] | select(.name | contains("P1P 0.4 nozzle")) | .name' "$work/bundled.json" | head -n 1)
process=$(jq -r --arg printer "$printer" '.process[] | select((.compatible_printers == null) or (.compatible_printers | index($printer))) | select(.name | contains("0.20mm Standard")) | .name' "$work/bundled.json" | head -n 1)
filament=$(jq -r --arg printer "$printer" '.filament[] | select((.compatible_printers == null) or (.compatible_printers | index($printer))) | select(.filament_type == "PLA") | select(.name | contains("Bambu PLA Basic")) | .name' "$work/bundled.json" | head -n 1)
[[ -n $printer && -n $process && -n $filament ]]
jq -n --arg name "$printer" '{type:"machine",name:$name,inherits:$name,from:"User"}' >"$work/printer.json"
jq -n --arg name "$process" '{type:"process",name:$name,inherits:$name,from:"User"}' >"$work/process.json"
jq -n --arg name "$filament" '{type:"filament",name:$name,inherits:$name,from:"User"}' >"$work/filament.json"

assert_clean() {
  curl --fail --silent "http://127.0.0.1:${port}/slice/status" \
    | jq -e '.active_slice_workspaces == 0 and .stale_slice_workspaces == 0 and .temp_bytes_used == 0 and .last_cleanup_failure == null' >/dev/null
  [[ -z $(docker exec "$container" find /tmp -xdev \( -name 'lock.txt' -o -name '_temp_*.config' -o -name 'slice-*' -o -name 'bamboo_model' \) -print) ]]
}

assert_clean
for iteration in 1 2 3; do
  curl --fail-with-body --silent --show-error \
    --output "$work/result-${iteration}.gcode.3mf" \
    --form "file=@tests/files/input/Cube.stl;type=model/stl" \
    --form "printerProfile=@${work}/printer.json;type=application/json" \
    --form "presetProfile=@${work}/process.json;type=application/json" \
    --form "filamentProfile=@${work}/filament.json;type=application/json" \
    --form-string 'plate=1' \
    --form-string 'exportType=3mf' \
    "http://127.0.0.1:${port}/slice"
  unzip -t "$work/result-${iteration}.gcode.3mf" >/dev/null
  assert_clean
done

printf 'not-json\n' >"$work/invalid-process.json"
status=$(curl --silent --show-error \
  --output "$work/failure.json" \
  --write-out '%{http_code}' \
  --form "file=@tests/files/input/Cube.stl;type=model/stl" \
  --form "printerProfile=@${work}/printer.json;type=application/json" \
  --form "presetProfile=@${work}/invalid-process.json;type=application/json" \
  --form "filamentProfile=@${work}/filament.json;type=application/json" \
  --form-string 'plate=1' \
  --form-string 'exportType=3mf' \
  "http://127.0.0.1:${port}/slice")
[[ $status == 400 ]]
jq -e '.message | contains("Invalid JSON in uploaded process profile")' "$work/failure.json" >/dev/null
assert_clean

# Simulate crash residue, restart the container, and prove the bounded tmpfs
# plus startup recovery cannot block the next job with stale lock state.
docker exec "$container" sh -c '
  mkdir -p /tmp/slice-crashed/runtime/bamboo_model/day/job
  printf "{}\n" >/tmp/slice-crashed/.pfm-slice-workspace.json
  printf "1\n" >/tmp/slice-crashed/runtime/bamboo_model/day/job/lock.txt
  mkdir -p /tmp/bamboo_model/day/legacy
  printf "1\n" >/tmp/bamboo_model/day/legacy/lock.txt
'
docker restart --timeout 3 "$container" >/dev/null
for _attempt in {1..90}; do
  curl --fail --silent --max-time 3 "http://127.0.0.1:${port}/health" >/dev/null && break
  sleep 1
done
assert_clean

curl --fail-with-body --silent --show-error \
  --output "$work/result-after-restart.gcode.3mf" \
  --form "file=@tests/files/input/Cube.stl;type=model/stl" \
  --form "printerProfile=@${work}/printer.json;type=application/json" \
  --form "presetProfile=@${work}/process.json;type=application/json" \
  --form "filamentProfile=@${work}/filament.json;type=application/json" \
  --form-string 'plate=1' \
  --form-string 'exportType=3mf' \
  "http://127.0.0.1:${port}/slice"
unzip -t "$work/result-after-restart.gcode.3mf" >/dev/null
assert_clean

echo "PFM SIDECAR TEMP CLEANUP INTEGRATION: PASS"
