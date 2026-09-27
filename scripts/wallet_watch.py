#!/usr/bin/env python3
"""SHIM tương thích — daemon THẬT nằm ở package `watchers/` (T7, plan evm-base-bsc).

Giữ nguyên 2 đường cũ:
  python3 scripts/wallet_watch.py --feed ws ...        (dev)
  /opt/wallet-watch/wallet_watch.py --min-usd 0.1 ...  (systemd ExecStart — scp file
      này + `scp -r watchers/` đặt cạnh bên; hoặc WATCH_HOME=/opt/wallet-watch)
Entrypoint mới: `python3 -m watchers.sol`.

Shim KHÔNG chứa logic. Nó nạp source của từng file trong `watchers/` (bỏ dòng import
nội-bộ) vào CÙNG MỘT namespace — đúng semantics của monolith cũ mà test dựa vào:
patch `ww.http_json` / `ww.min_usd` / `ww.STATE_PATH` phải được MỌI hàm trong daemon
nhìn thấy, và `exec(src, ww.__dict__)` của mutation gate (test_gmgn_api_parity) phải
đổi được đúng hàm mà caller thật đang gọi.
"""

import ast
import os
import sys

_root = os.path.dirname(os.path.abspath(__file__))
while not os.path.isdir(os.path.join(_root, "watchers")) and _root != os.path.dirname(
    _root
):
    _root = os.path.dirname(_root)
_PKG = os.path.join(_root, "watchers")

# thứ tự = thứ tự dependency; module-level của mỗi file chỉ dùng tên của file trước
_SECTIONS = (
    "common/config.py",
    "common/state.py",
    "common/price.py",
    "common/emit.py",
    "sol/classify.py",
    "sol/feed.py",
    "sol/main.py",
)
# tên được tham chiếu dạng `config.rpc(...)` / `emit._jsonl` trong code đã dời
_QUALIFIERS = ("config", "state", "price", "emit", "classify", "feed")

_FLAT = globals()


class _Ns:
    """View thuộc-tính của namespace phẳng: `config.rpc(...)` trong code đã dời phải
    trỏ tới binding HIỆN HÀNH ở đây (production = giá trị thật, test = bản đã patch)."""

    def __getattr__(self, name):
        try:
            return _FLAT[name]
        except KeyError:
            raise AttributeError(name) from None

    def __setattr__(self, name, value):
        _FLAT[name] = value


def _section_src(path):
    """Source của 1 file trong `watchers/`, các import nội-bộ thay bằng dòng TRỐNG
    (không xoá) — số dòng phải giữ nguyên y file trên disk, nếu không
    `inspect.getsource` của mutation gate đọc lệch dòng."""
    with open(path) as f:
        src = f.read()
    lines = src.splitlines(True)
    for node in ast.parse(src).body:
        if not isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        mods = (
            [node.module]
            if isinstance(node, ast.ImportFrom)
            else [a.name for a in node.names]
        )
        if any((m or "").split(".")[0] == "watchers" for m in mods):
            last = node.end_lineno or node.lineno
            for i in range(node.lineno - 1, last):
                lines[i] = "\n"
    return "".join(lines)


for _rel in _SECTIONS:
    _path = os.path.join(_PKG, _rel)
    exec(compile(_section_src(_path), _path, "exec"), _FLAT)  # noqa: S102

for _q in _QUALIFIERS:
    _FLAT[_q] = _Ns()

if _root not in sys.path:
    sys.path.insert(0, _root)
import watchers.sol.main  # noqa: E402,F401 — package thật PHẢI import được (fail loud)

if __name__ == "__main__":
    watchers.sol.main.main()
