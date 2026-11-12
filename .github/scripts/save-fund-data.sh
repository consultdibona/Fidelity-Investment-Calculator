#!/usr/bin/env bash
# Commit a changed funds.json without discarding commits that arrived during API calls.
set -euo pipefail

if git diff --quiet -- data/funds.json; then
  echo "No fund-data changes to save."
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -- data/funds.json
git commit -m "${1:-Refresh fund data}"

for attempt in 1 2 3 4 5; do
  echo "Push attempt ${attempt}: fetch and rebase on latest main."
  git fetch origin main
  if ! git rebase origin/main; then
    git rebase --abort || true
    echo "::error::Another commit changed the same data during the refresh. Keeping their changes; refusing to overwrite. Re-run the workflow." >&2
    exit 1
  fi
  if git push origin HEAD:main; then
    echo "Fund data saved on main."
    exit 0
  fi
  echo "Main moved again during the push. Retrying safely."
  sleep $((attempt * 2))
done

echo "::error::Could not push after five rebased attempts; see the fund-data artifact attached to this workflow run." >&2
exit 1
