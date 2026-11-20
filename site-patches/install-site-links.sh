#!/bin/sh
# Usage: sh site-patches/install-site-links.sh NEW_STAGING_DIR [FILE ...]
# Run from the repository root. Stages the canonical site-link files in a new
# LOCAL directory only: no ssh, scp, git push, deploy, systemctl or Caddy reload.
# With no FILE arguments it stages the canonical home page and its navigation
# files, site/imperial.html among them.
set -eu

if [ "$#" -lt 1 ]; then
    printf '%s\n' 'Usage: install-site-links.sh NEW_STAGING_DIR [FILE ...]' >&2
    exit 2
fi

staging_dir=$1
shift
case "$staging_dir" in
    /*|./*) ;;
    *) staging_dir=./$staging_dir ;;
esac

if [ "$#" -eq 0 ]; then
    set -- site/imperial.html site/panel.js site/tree.json site/manifest.webmanifest
fi

for file do
    case "$file" in
        *[!a-zA-Z0-9._/-]*|*/../*|*/..|*/./*|*/.|*//*|*/|*/.env|*/.env.*)
            printf 'Invalid file path: %s\n' "$file" >&2
            exit 2
            ;;
        site/*|web/*|test/*|tools/*|deploy/*|site-patches/*) ;;
        *)
            printf 'Unexpected file path: %s\n' "$file" >&2
            exit 2
            ;;
    esac
    if [ ! -f "$file" ] || [ -L "$file" ]; then
        printf 'Expected a regular file: %s\n' "$file" >&2
        exit 2
    fi
done

mkdir "$staging_dir"
for file do
    mkdir -p "$staging_dir/${file%/*}"
    cp -p "$file" "$staging_dir/$file"
done
