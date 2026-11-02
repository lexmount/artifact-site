#!/bin/sh
set -eu
mkdir -p dist-archive
if [ "$(uname -s)" = Darwin ]; then
  archive_prefix=$(brew --prefix libarchive)
  export CPATH="$archive_prefix/include${CPATH:+:$CPATH}"
  export LIBRARY_PATH="$archive_prefix/lib${LIBRARY_PATH:+:$LIBRARY_PATH}"
fi
cc -O2 -Wall -Wextra scripts/archive/reader.c -larchive -o dist-archive/reader
