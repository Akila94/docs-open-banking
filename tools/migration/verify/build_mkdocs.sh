#!/usr/bin/env bash
# Build the original MkDocs site (the verification oracle) from a git revision.
#
# Usage: build_mkdocs.sh <git-sha> <out-dir>
#
# Archives `en/` at <git-sha> into a temporary directory and runs `mkdocs build` there with the
# pinned toolchain (MkDocs 1.1.2 + Material 4.6.3, see requirements-mkdocs.txt).
#
# PYTHON 3.9 IS REQUIRED: mkdocs 1.1.2 does not run on Python >= 3.10. The interpreter is taken from
# $MKDOCS_PYTHON (default: python3.9 on PATH). One way to get it:
#   uv python install 3.9 && export MKDOCS_PYTHON="$(uv python find 3.9)"
#
# Environment:
#   MKDOCS_PYTHON  Python 3.9 interpreter used to create the venv (default: python3.9)
#   MKDOCS_VENV    venv location, created or reused (default: <this dir>/.venv-mkdocs, git-ignored)
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REQUIREMENTS_FILE="${SCRIPT_DIR}/requirements-mkdocs.txt"
readonly VENV_DIR="${MKDOCS_VENV:-${SCRIPT_DIR}/.venv-mkdocs}"
readonly PYTHON_BIN="${MKDOCS_PYTHON:-python3.9}"
readonly REQUIREMENTS_STAMP="${VENV_DIR}/.requirements.sha256"

work_dir=""

log() { printf 'build_mkdocs: %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Remove the temporary working directory on every exit path.
cleanup() {
  if [[ -n "${work_dir}" && -d "${work_dir}" ]]; then
    rm -rf -- "${work_dir}"
  fi
}
trap cleanup EXIT

# Print usage and exit with an error.
usage() {
  printf 'Usage: %s <git-sha> <out-dir>\n' "$(basename "$0")" >&2
  exit 2
}

# True when the given interpreter is Python 3.9.x.
is_python_39() {
  "$1" -I -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 9) else 1)' >/dev/null 2>&1
}

# SHA-256 of the requirements file, used to decide whether the venv is still up to date.
requirements_digest() {
  shasum -a 256 "${REQUIREMENTS_FILE}" | cut -d' ' -f1
}

# Create the venv from the hash-pinned requirements, or reuse it when it is current.
ensure_venv() {
  local digest
  digest="$(requirements_digest)"
  if [[ -x "${VENV_DIR}/bin/python" ]] && is_python_39 "${VENV_DIR}/bin/python" \
      && [[ -f "${REQUIREMENTS_STAMP}" && "$(cat "${REQUIREMENTS_STAMP}")" == "${digest}" ]]; then
    log "reusing venv ${VENV_DIR}"
    return
  fi

  command -v "${PYTHON_BIN}" >/dev/null 2>&1 \
    || die "Python 3.9 is required but '${PYTHON_BIN}' was not found. Set MKDOCS_PYTHON to a Python 3.9 interpreter (e.g. 'uv python install 3.9')."
  is_python_39 "${PYTHON_BIN}" \
    || die "Python 3.9 is required (mkdocs 1.1.2 does not run on Python >= 3.10) but '${PYTHON_BIN}' is: $("${PYTHON_BIN}" -I -V 2>&1). Set MKDOCS_PYTHON to a Python 3.9 interpreter."

  if [[ -e "${VENV_DIR}" ]]; then
    [[ -f "${VENV_DIR}/pyvenv.cfg" ]] || die "${VENV_DIR} exists but is not a venv; refusing to delete it."
    log "recreating outdated venv ${VENV_DIR}"
    rm -rf -- "${VENV_DIR}"
  fi
  log "creating venv ${VENV_DIR} with $("${PYTHON_BIN}" -I -V 2>&1)"
  "${PYTHON_BIN}" -I -m venv "${VENV_DIR}"
  "${VENV_DIR}/bin/python" -I -m pip install --disable-pip-version-check --quiet \
    --require-hashes -r "${REQUIREMENTS_FILE}"
  printf '%s\n' "${digest}" > "${REQUIREMENTS_STAMP}"
}

# Refuse output directories that mkdocs' clean step could use to destroy unrelated files.
check_out_dir() {
  local out_dir="$1"
  [[ "${out_dir}" != "/" && "${out_dir}" != "${HOME:-}" && "${out_dir}" != "${REPO_ROOT}" ]] \
    || die "refusing to use ${out_dir} as the output directory."
  if [[ -e "${out_dir}" ]]; then
    [[ -d "${out_dir}" ]] || die "${out_dir} exists and is not a directory."
    if [[ -n "$(ls -A "${out_dir}")" && ! -f "${out_dir}/sitemap.xml" ]]; then
      die "${out_dir} is not empty and does not look like a previous MkDocs build (no sitemap.xml); refusing to overwrite it."
    fi
  fi
}

main() {
  [[ $# -eq 2 ]] || usage
  local git_sha="$1" out_arg="$2"
  [[ "${git_sha}" =~ ^[0-9a-fA-F]{7,40}$ ]] || die "'${git_sha}' is not a git commit SHA (7-40 hex characters)."

  REPO_ROOT="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel)" || die "not inside a git repository."
  git -C "${REPO_ROOT}" cat-file -e "${git_sha}^{commit}" 2>/dev/null || die "commit ${git_sha} not found in ${REPO_ROOT}."

  mkdir -p -- "${out_arg}"
  local out_dir
  out_dir="$(cd "${out_arg}" && pwd -P)"
  check_out_dir "${out_dir}"

  ensure_venv

  work_dir="$(mktemp -d)"
  log "archiving en/ at ${git_sha}"
  git -C "${REPO_ROOT}" archive "${git_sha}" en | tar -x -C "${work_dir}"
  [[ -f "${work_dir}/en/mkdocs.yml" ]] || die "en/mkdocs.yml missing at ${git_sha}."

  log "building into ${out_dir}"
  (cd "${work_dir}/en" && "${VENV_DIR}/bin/python" -I -m mkdocs build --quiet -d "${out_dir}")
  [[ -f "${out_dir}/index.html" ]] || die "build finished but ${out_dir}/index.html is missing."
  log "done: $(find "${out_dir}" -name '*.html' | wc -l | tr -d ' ') HTML files in ${out_dir}"
}

main "$@"
