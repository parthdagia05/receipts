#!/usr/bin/env bash
#
# Build and push the ARM64 API image, idempotently.
#
#   ./ecr-push.sh <registry> <repository> <tag> [context-dir]
#
# The ECR repository has IMMUTABLE tags, which is what makes a SHA tag mean
# exactly one image forever. The cost is that pushing a tag that already
# exists is an error -- so re-running a deploy on the same commit, which is
# an ordinary thing to do after a transient failure, used to fail the
# workflow at the push step before it ever reached the deploy.
#
# So: check first, and treat "already published" as success. The image for a
# given SHA is by definition the one already there.

set -Eeuo pipefail

log()  { printf '%s [push] %s\n'       "$(date -u +%FT%TZ)" "$*"; }
fail() { trap - ERR; printf '%s [push] FAIL: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; exit 1; }

# Does this exact tag already exist in the repository?
image_exists() {
  local repository="$1" tag="$2"
  aws ecr describe-images \
    --repository-name "$repository" \
    --image-ids "imageTag=$tag" \
    >/dev/null 2>&1
}

main() {
  local registry="${1:-}" repository="${2:-}" tag="${3:-}" context="${4:-server}"

  [ -n "$registry" ]   || fail "usage: ecr-push.sh <registry> <repository> <tag> [context]"
  [ -n "$repository" ] || fail "usage: ecr-push.sh <registry> <repository> <tag> [context]"
  [ -n "$tag" ]        || fail "usage: ecr-push.sh <registry> <repository> <tag> [context]"

  case "$tag" in
    latest|local|main|master)
      fail "refusing to push moving tag '$tag' to an immutable repository" ;;
  esac

  local image="$registry/$repository:$tag"

  if image_exists "$repository" "$tag"; then
    log "$image already published; skipping build and push (immutable tags)"
    return 0
  fi

  # arm64 because the instance is a Graviton t4g. An amd64 image fails to
  # start there with an exec format error.
  log "building and pushing $image (linux/arm64)"
  docker buildx build --platform linux/arm64 -t "$image" --push "$context" \
    || fail "build or push failed for $image"

  log "pushed $image"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
