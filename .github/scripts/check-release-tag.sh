#!/usr/bin/env bash
# Refuses to publish unless the release tag is "v" + the version in package.json.
set -euo pipefail
tag="${1:?release tag}"
expected="v$(node -p "require('./package.json').version")"
if [ "$tag" != "$expected" ]; then
  echo "::error::Release tag $tag does not match package.json ($expected). Merge the version PR first, then create the release with tag $expected."
  exit 1
fi
echo "Release tag $tag matches package.json."
