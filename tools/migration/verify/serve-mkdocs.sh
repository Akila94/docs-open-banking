#!/usr/bin/env bash
# Serve a built MkDocs site on 127.0.0.1:8000 (loopback only) for manual inspection.
#
# Usage: serve-mkdocs.sh <site-dir>     (or set MK_SITE_DIR), e.g. SCRATCH/mk-site
#
# Environment:
#   SERVE_PYTHON  Python used for http.server (default: python3; any Python 3.7+ works)
set -euo pipefail

readonly PORT=8000
readonly BIND_ADDRESS="127.0.0.1"
readonly PYTHON_BIN="${SERVE_PYTHON:-python3}"

site_dir="${1:-${MK_SITE_DIR:-}}"
if [[ -z "${site_dir}" ]]; then
  printf 'Usage: %s <site-dir>   (or set MK_SITE_DIR)\n' "$(basename "$0")" >&2
  exit 2
fi
if [[ ! -f "${site_dir}/index.html" ]]; then
  printf 'serve-mkdocs: %s does not contain a built site (index.html missing); run build_mkdocs.sh first.\n' "${site_dir}" >&2
  exit 1
fi

printf 'serve-mkdocs: serving %s on http://%s:%s/ (Ctrl-C to stop)\n' "${site_dir}" "${BIND_ADDRESS}" "${PORT}" >&2
exec "${PYTHON_BIN}" -I -m http.server "${PORT}" --bind "${BIND_ADDRESS}" --directory "${site_dir}"
