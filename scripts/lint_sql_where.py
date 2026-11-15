#!/usr/bin/env python3
"""Fails when a migration contains an UPDATE or DELETE statement without a top-level WHERE clause.

Supabase enables pg_safeupdate for the API roles: such a statement raises "UPDATE requires a WHERE clause" when it runs
inside an RPC, although it works for the postgres role used by pgTAP. Use `where true` when every row is meant.
Usage: lint_sql_where.py <dir with *.sql>
"""
import glob
import re
import sys


def strip_comments(s: str) -> str:
    return re.sub(r'--[^\n]*', lambda m: ' ' * len(m.group(0)), s)


def main(root: str) -> int:
    bad = 0
    for f in sorted(glob.glob(f'{root}/*.sql')):
        s = strip_comments(open(f, encoding='utf-8').read())
        for m in re.finditer(r'(?i)(?<![\w.])(update\s+(?:only\s+)?[\w."]+(?:\s+(?:as\s+)?(?!set\b)\w+)?\s+set\b|delete\s+from\s+(?:only\s+)?[\w."]+(?:\s+(?:as\s+)?(?!where\b|using\b|returning\b)\w+)?)', s):
            i, depth, quote = m.end(), 0, None
            while i < len(s):
                c = s[i]
                if quote:
                    if c == quote:
                        quote = None
                elif c == "'":
                    quote = "'"
                elif c == '(':
                    depth += 1
                elif c == ')':
                    if depth == 0:
                        break
                    depth -= 1
                elif c == ';' and depth == 0:
                    break
                i += 1
            seg = s[m.start():i]
            top = seg
            for _ in range(8):
                top = re.sub(r'\([^()]*\)', ' ', top)
            if not re.search(r'(?i)\bwhere\b', top):
                bad += 1
                print(f'{f}:{s[:m.start()].count(chr(10)) + 1}: {seg[:100]!r} has no WHERE (pg_safeupdate)')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else 'supabase/migrations'))
