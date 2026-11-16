#!/usr/bin/env python3
"""使い方: compare.py <期待値のディレクトリ> <実測値のディレクトリ>  … 実測値側にあるファイルについて項目ごとの差分を Markdown で出力する。"""
import json
import os
import sys

KEYS = ['stats', 'kpi', 'version', 'sha', 'hash', 'count', 'total', 'otp', 'delay', 'cancel', 'divert', 'rating', 'cash', 'profit']


def walk(a, b, path, out):
    if type(a) is not type(b):
        out.append((path, a, b))
    elif isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append((path + '.' + k, '(なし)', b[k]))
            elif k not in b:
                out.append((path + '.' + k, a[k], '(なし)'))
            else:
                walk(a[k], b[k], path + '.' + k, out)
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append((path + '.length', len(a), len(b)))
        for i, (x, y) in enumerate(zip(a, b)):
            walk(x, y, f'{path}[{i}]', out)
    elif a != b:
        out.append((path, a, b))


def short(v):
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    return s if len(s) <= 60 else s[:57] + '...'


def main(expected, actual):
    print('| ファイル | 異なる項目数 | 主な差（期待 → 実測） |')
    print('|---|---|---|')
    detail = []
    for f in sorted(os.listdir(actual)):
        if not f.endswith('.json') or not os.path.exists(os.path.join(expected, f)):
            continue
        out = []
        walk(json.load(open(os.path.join(expected, f))), json.load(open(os.path.join(actual, f))), '', out)
        out.sort(key=lambda p: (0 if any(t in p[0].lower() for t in KEYS) else 1, len(p[0])))
        main_diff = '; '.join(f'`{p[0].lstrip(".")}` {short(p[1])} → {short(p[2])}' for p in out[:4])
        print(f'| {f} | {len(out)} | {main_diff} |')
        detail.append((f, out))
    for f, out in detail:
        print(f'\n### {f}\n')
        for p in out[:40]:
            print(f'- `{p[0].lstrip(".")}`: {short(p[1])} → {short(p[2])}')
        if len(out) > 40:
            print(f'- …ほか {len(out) - 40} 項目')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
