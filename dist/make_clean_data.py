"""
生成打包用的「干净示例数据」，输出到 dist/clean-data/
打包时用它替换 data/，避免把用户的真实待办、随手记、目录路径带出去。

用法：python make_clean_data.py
"""
import json
import os
import time
from datetime import datetime, timedelta

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "clean-data")

# 示例数据用固定时间戳：每次生成结果一致，打包不会产生无意义的 diff
now_ms = 1794580509487      # 2026-11-13 10:35:09


def d(offset_days):
    return (datetime.now() + timedelta(days=offset_days)).strftime("%Y-%m-%d")


todos = [
    {"id": "seed-1", "text": "双击格子里的空白处，可以直接新建待办",
     "date": d(0), "done": False, "created": now_ms},
    {"id": "seed-2", "text": "单击事项划掉，双击事项改字，悬停右侧 ✕ 删除",
     "date": d(0), "done": True, "created": now_ms - 60000, "doneAt": now_ms},
    {"id": "seed-3", "text": "格子装不下时，点右上角的数字徽标看当天全部",
     "date": d(1), "done": False, "created": now_ms},
    {"id": "seed-4", "text": "每格显示几行，在设置面板 →「待办 · 月历」里改",
     "date": d(2), "done": False, "created": now_ms},
    {"id": "seed-5", "text": "待办存在 data/todos.json，可以直接用记事本改",
     "date": d(3), "done": False, "created": now_ms},
]

notes = [
    {"id": "seed-n1", "body": "这是一条随手记。点右上角「+ 新记」可以添加，输入框里能搜历史。",
     "created": now_ms - 120000, "updated": now_ms - 120000},
    {"id": "seed-n2", "body": "所有记下来的东西都在 data/notes.json，整目录复制就能备份。",
     "created": now_ms - 60000, "updated": now_ms - 60000},
]

progress = [
    {"id": "seed-p1", "label": "本月读书", "current": 2, "target": 8,
     "unit": " 本", "step": 1, "color": "#5aa2ff"},
]

stocks = {
    "list": [
        {"secid": "1.000001", "name": "上证指数", "pinned": True},
        {"secid": "0.399006", "name": "创业板指", "pinned": True},
        {"secid": "0.399001", "name": "深证成指"},
        {"secid": "1.600519", "name": "贵州茅台"},
    ],
    "refreshSec": 60,
}

# 布局：月历占满上半屏，底部 6 张并排（290 宽，间距 20）
# 40 + 6*290 + 5*20 = 1880，右边距 40，正好贴齐 1920 逻辑宽度
_W, _GAP, _Y, _H = 290, 20, 602, 398
_bottom = [
    ("w-clock", "clock"),
    ("w-notes", "notes"),
    ("w-files", "files"),
    ("w-stocks", "stocks"),
    ("w-xyz", "xyz"),
    ("w-xueqiu", "xueqiu"),
]
layout = {
    "widgets": [
                           {"id": "w-todos", "type": "todos", "x": 40, "y": 52, "w": 1840, "h": 530,
                            "opacity": 1, "z": 10, "config": {}},
                       ] + [
        {"id": _id, "type": _t, "x": 40 + i * (_W + _GAP), "y": _Y, "w": _W, "h": _H,
         "opacity": 1, "z": 11 + i,
         "config": ({"lat": 30.67, "lon": 104.07, "city": "成都"} if _t == "clock" else {})}
        for i, (_id, _t) in enumerate(_bottom)
    ],
    "viewportW": 1920,
    "viewportH": 1040,
}

settings = {
    "theme": {"name": "深蓝", "h": 220, "s": 27, "l": 6},
    "type": {
        "fontCjk": "Microsoft YaHei UI",
        "fontLatin": "Segoe UI",
        "colorText": "#eef2f7",
        "colorDim": "#b3bfd0",
    },
    "calendar": {"maxRows": 3, "weeks": 5},
    "uiScale": "auto",
}

os.makedirs(OUT, exist_ok=True)


def dump(name, obj):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    print("  " + name)


print("生成示例数据 →", OUT)
dump("todos.json", todos)
dump("notes.json", notes)
dump("progress.json", progress)
dump("stocks.json", stocks)
dump("layout.json", layout)
dump("settings.json", settings)
# 注意：不生成 fsroots.json —— 让 server.js 按目标机器的家目录自动生成
print("  (fsroots.json 不生成，由 server 按家目录自动创建)")
print("完成")
