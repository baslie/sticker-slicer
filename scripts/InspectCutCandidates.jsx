/*
================================================================================
  InspectCutCandidates.jsx — поиск «спрятанного» контура реза
================================================================================

  Когда нужен: PreflightBatch нашёл подозрительно мало контуров реза
  (как в NAKL_KOTYKI_135 — 48 открытых линий вместо ~135 стикеров).
  StickerExporter ищет рез ТОЛЬКО по обводке (stroked path). Если дилайн задан
  заливкой, лежит в подслоях или это незамкнутые линии — экспортёр его не видит.

  Что делает (по АКТИВНОМУ документу):
  - Обходит все слои/подслои/группы/compound-пути.
  - Классифицирует каждый путь: stroked / filled / closed.
  - Группирует ЗАМКНУТЫЕ пути по цвету ЗАЛИВКИ (вдруг рез — это заливка).
  - Группирует обводки по цвету (как экспортёр).
  - Считает: всего путей, замкнутых, открытых, с обводкой, только-залитых
    замкнутых (главные кандидаты в «рез заливкой»).
  - Показывает состав первых 8 групп верхнего уровня (из чего собран стикер).
  - Отдельно отмечает пути в ПОДслоях (блайндспот экспортёра).

  Отчёт: <имя_документа>__inspect.txt рядом с .ai (или на Desktop).
  Запуск: открыть проблемный .ai → File → Scripts → Other Script… → этот файл.
================================================================================
*/

#target illustrator

(function () {

    if (app.documents.length === 0) {
        alert("Открой проблемный .ai и запусти скрипт снова.");
        return;
    }
    var doc = app.activeDocument;
    var MM2PT = 2.83464567;
    function ptToMm(pt) { return Math.round((pt / MM2PT) * 100) / 100; }

    var lines = [];
    function L(s) { lines.push(s == null ? "" : String(s)); }

    function colorDesc(c) {
        if (!c) return "none";
        try {
            if (c.typename === "SpotColor" && c.spot)
                return 'Spot:"' + c.spot.name + '"';
            if (c.typename === "CMYKColor")
                return "CMYK(" + Math.round(c.cyan) + "," + Math.round(c.magenta) +
                       "," + Math.round(c.yellow) + "," + Math.round(c.black) + ")";
            if (c.typename === "RGBColor")
                return "RGB(" + Math.round(c.red) + "," + Math.round(c.green) +
                       "," + Math.round(c.blue) + ")";
            if (c.typename === "GrayColor") return "Gray(" + Math.round(c.gray) + ")";
            if (c.typename === "NoColor")   return "none";
            return c.typename;
        } catch (e) { return "?"; }
    }

    // ---------- Накопители ----------------------------------------------
    var stat = {
        totalPaths: 0, closed: 0, open: 0, stroked: 0,
        filledClosed: 0, filledOnlyClosed: 0, inSublayers: 0
    };
    var fillGroups = {}, fillOrder = [];     // замкнутые пути по цвету заливки
    var strokeGroups = {}, strokeOrder = []; // обводки по цвету

    function bump(map, order, key, label, p) {
        if (!map[key]) {
            map[key] = { label: label, count: 0, sampleBboxMm: null, sampleSw: null };
            order.push(key);
        }
        var g = map[key];
        g.count++;
        if (g.sampleBboxMm == null) {
            try {
                var b = p.geometricBounds;
                g.sampleBboxMm = { w: ptToMm(b[2] - b[0]), h: ptToMm(b[1] - b[3]) };
            } catch (e) {}
        }
        if (g.sampleSw == null) {
            try { g.sampleSw = Math.round(p.strokeWidth * 100) / 100; } catch (e) {}
        }
    }

    function classifyPath(p, inSub) {
        stat.totalPaths++;
        if (inSub) stat.inSublayers++;
        var isClosed = false, isStroked = false, isFilled = false;
        try { isClosed = p.closed; } catch (e) {}
        try { isStroked = p.stroked; } catch (e) {}
        try { isFilled = p.filled; } catch (e) {}
        if (isClosed) stat.closed++; else stat.open++;
        if (isStroked) {
            stat.stroked++;
            var sd = colorDesc(p.strokeColor);
            bump(strokeGroups, strokeOrder, "s::" + sd, sd, p);
        }
        if (isClosed && isFilled) {
            stat.filledClosed++;
            var fd = colorDesc(p.fillColor);
            bump(fillGroups, fillOrder, "f::" + fd, fd, p);
            if (!isStroked) stat.filledOnlyClosed++;
        }
    }

    function walk(c, inSub) {
        try {
            for (var i = 0; i < c.pathItems.length; i++) classifyPath(c.pathItems[i], inSub);
        } catch (e) {}
        try {
            for (var cc = 0; cc < c.compoundPathItems.length; cc++) {
                var cp = c.compoundPathItems[cc];
                for (var k = 0; k < cp.pathItems.length; k++) classifyPath(cp.pathItems[k], inSub);
            }
        } catch (e) {}
        try {
            for (var g = 0; g < c.groupItems.length; g++) walk(c.groupItems[g], inSub);
        } catch (e) {}
        try {
            for (var sl = 0; sl < c.layers.length; sl++) walk(c.layers[sl], true);
        } catch (e) {}
    }

    // ---------- Заголовок -----------------------------------------------
    L("=== INSPECT CUT CANDIDATES ===");
    L("Документ: " + doc.name);
    L("Color space: " + doc.documentColorSpace);
    L("");

    for (var li = 0; li < doc.layers.length; li++) walk(doc.layers[li], false);

    // ---------- Сводка по путям -----------------------------------------
    L("=== СТАТИСТИКА ПУТЕЙ ===");
    L("Всего путей:                  " + stat.totalPaths);
    L("  замкнутых:                  " + stat.closed);
    L("  открытых:                   " + stat.open);
    L("  с обводкой (видит экспортёр): " + stat.stroked);
    L("  замкнутых + залитых:        " + stat.filledClosed);
    L("  замкнутых, ТОЛЬКО заливка (без обводки): " + stat.filledOnlyClosed +
      "   <- главный кандидат в «рез заливкой»");
    if (stat.inSublayers > 0)
        L("  ИЗ НИХ в подслоях:          " + stat.inSublayers + "   <- экспортёр их НЕ видит");
    L("");

    // ---------- Замкнутые пути по цвету ЗАЛИВКИ --------------------------
    L("=== ЗАМКНУТЫЕ ПУТИ ПО ЦВЕТУ ЗАЛИВКИ ===");
    L("(если тут есть цвет с количеством ≈ числу стикеров — это и есть рез заливкой)");
    fillOrder.sort(function (a, b) { return fillGroups[b].count - fillGroups[a].count; });
    for (var fi = 0; fi < fillOrder.length; fi++) {
        var fg = fillGroups[fillOrder[fi]];
        L("  [" + fg.count + "] fill " + fg.label +
          (fg.sampleBboxMm ? "  bbox≈" + fg.sampleBboxMm.w + "x" + fg.sampleBboxMm.h + "мм" : ""));
    }
    L("");

    // ---------- Обводки по цвету ----------------------------------------
    L("=== ОБВОДКИ ПО ЦВЕТУ (как видит экспортёр) ===");
    strokeOrder.sort(function (a, b) { return strokeGroups[b].count - strokeGroups[a].count; });
    for (var si = 0; si < strokeOrder.length; si++) {
        var sg = strokeGroups[strokeOrder[si]];
        L("  [" + sg.count + "] stroke " + sg.label +
          (sg.sampleSw != null ? "  sw=" + sg.sampleSw + "pt" : "") +
          (sg.sampleBboxMm ? "  bbox≈" + sg.sampleBboxMm.w + "x" + sg.sampleBboxMm.h + "мм" : ""));
    }
    L("");

    // ---------- Состав первых групп верхнего уровня ----------------------
    L("=== СОСТАВ ПЕРВЫХ ГРУПП (как собран один стикер) ===");
    var shown = 0;
    function describeItem(it) {
        var t = it.typename, extra = "";
        try {
            if (t === "PathItem") {
                extra = (it.closed ? "closed" : "open") +
                        (it.stroked ? " stroke=" + colorDesc(it.strokeColor) : "") +
                        (it.filled ? " fill=" + colorDesc(it.fillColor) : "");
            }
        } catch (e) {}
        return t + (extra ? " [" + extra + "]" : "");
    }
    for (var lg = 0; lg < doc.layers.length && shown < 8; lg++) {
        var lay = doc.layers[lg];
        for (var gi = 0; gi < lay.groupItems.length && shown < 8; gi++) {
            var grp = lay.groupItems[gi];
            shown++;
            var parts = [];
            try {
                for (var pi = 0; pi < grp.pageItems.length && pi < 12; pi++)
                    parts.push(describeItem(grp.pageItems[pi]));
            } catch (e) {}
            L("  Группа #" + shown + " (слой \"" + lay.name + "\", элементов " +
              grp.pageItems.length + "):");
            for (var pp = 0; pp < parts.length; pp++) L("      - " + parts[pp]);
        }
    }
    L("");

    // ---------- Сохранение ----------------------------------------------
    var outPath;
    try { outPath = doc.fullName.parent.fsName + "/" + doc.name + "__inspect.txt"; }
    catch (e) { outPath = Folder.desktop.fsName + "/" + doc.name + "__inspect.txt"; }

    var f = new File(outPath);
    f.encoding = "UTF-8";
    if (f.open("w")) {
        f.write(lines.join("\n"));
        f.close();
        alert("Отчёт сохранён:\n" + outPath + "\n\nПерешли его в чат с Claude.");
    } else {
        alert("Не удалось записать отчёт в:\n" + outPath);
    }

})();
