/*
================================================================================
  DiagnoseDocument.jsx — диагностический дамп структуры .ai документа
================================================================================

  Что делает:
  - Проходит по всем слоям/группам/объектам активного документа.
  - Собирает: иерархию слоёв, список path-объектов с обводкой и заливкой,
    группировку по цветам обводки (spot/CMYK/RGB), список artboards в мм,
    общую статистику.
  - Сохраняет отчёт в файл report.txt рядом с .ai (или на Desktop).
  - Цель: понять структуру нового макета, чтобы адаптировать StickerExporter.

  Запуск: File → Scripts → Other Script… → DiagnoseDocument.jsx
================================================================================
*/

#target illustrator

(function () {

    if (app.documents.length === 0) {
        alert("Откройте .ai файл и запустите скрипт снова.");
        return;
    }

    var doc = app.activeDocument;
    var MM2PT = 2.83464567;
    function ptToMm(pt) { return Math.round((pt / MM2PT) * 100) / 100; }

    var lines = [];
    function L(s) { lines.push(s == null ? "" : String(s)); }

    // ---------- Заголовок -----------------------------------------------
    L("=== ДИАГНОСТИКА ДОКУМЕНТА ===");
    L("Имя: " + doc.name);
    try { L("Путь: " + doc.fullName.fsName); } catch (e) { L("Путь: (не сохранён)"); }
    L("Color space: " + doc.documentColorSpace);
    L("Слоёв (верхний уровень): " + doc.layers.length);
    L("Артбордов: " + doc.artboards.length);
    L("");

    // ---------- Artboards -----------------------------------------------
    L("=== ARTBOARDS ===");
    for (var ai = 0; ai < doc.artboards.length; ai++) {
        var ab = doc.artboards[ai];
        var r = ab.artboardRect; // [L, T, R, B]
        var w = ptToMm(r[2] - r[0]);
        var h = ptToMm(r[1] - r[3]);
        L("[" + ai + "] \"" + ab.name + "\"  " + w + " x " + h + " мм" +
          "  (L=" + ptToMm(r[0]) + " T=" + ptToMm(r[1]) +
          " R=" + ptToMm(r[2]) + " B=" + ptToMm(r[3]) + " мм)");
    }
    L("");

    // ---------- Утилиты описания цвета ---------------------------------
    function colorDesc(c) {
        if (!c) return "none";
        try {
            if (c.typename === "SpotColor" && c.spot) {
                return "Spot:\"" + c.spot.name + "\"" +
                       " tint=" + (c.tint != null ? c.tint : 100);
            }
            if (c.typename === "CMYKColor") {
                return "CMYK(" +
                       Math.round(c.cyan) + "," +
                       Math.round(c.magenta) + "," +
                       Math.round(c.yellow) + "," +
                       Math.round(c.black) + ")";
            }
            if (c.typename === "RGBColor") {
                return "RGB(" +
                       Math.round(c.red) + "," +
                       Math.round(c.green) + "," +
                       Math.round(c.blue) + ")";
            }
            if (c.typename === "GrayColor") return "Gray(" + Math.round(c.gray) + ")";
            if (c.typename === "NoColor")   return "NoColor";
            if (c.typename === "PatternColor") return "Pattern";
            if (c.typename === "GradientColor") return "Gradient";
            return c.typename;
        } catch (e) { return "?"; }
    }

    // ---------- Сбор статистики по объектам ----------------------------
    var stats = {
        path: 0, compound: 0, group: 0, text: 0,
        placed: 0, raster: 0, symbol: 0, mesh: 0, other: 0
    };

    // Группировка stroked-путей по цвету обводки
    var strokeGroups = {}; // key → { label, count, sampleBounds, sampleStrokeWidth }
    var strokeOrder = [];

    function addStrokeGroup(key, label, p) {
        if (!strokeGroups[key]) {
            strokeGroups[key] = {
                label: label,
                count: 0,
                sampleStrokeWidth: null,
                sampleBoundsMm: null
            };
            strokeOrder.push(key);
        }
        var g = strokeGroups[key];
        g.count++;
        if (g.sampleStrokeWidth == null) {
            try { g.sampleStrokeWidth = p.strokeWidth; } catch (e) {}
        }
        if (g.sampleBoundsMm == null) {
            try {
                var b = p.geometricBounds;
                g.sampleBoundsMm = {
                    w: ptToMm(b[2] - b[0]),
                    h: ptToMm(b[1] - b[3])
                };
            } catch (e) {}
        }
    }

    function processPath(p, layerName) {
        try {
            if (p.stroked) {
                var sc = p.strokeColor;
                var key, label;
                if (sc && sc.typename === "SpotColor" && sc.spot) {
                    key = "spot::" + sc.spot.name;
                    label = "Spot \"" + sc.spot.name + "\"";
                } else {
                    var d = colorDesc(sc);
                    key = "col::" + d;
                    label = d;
                }
                addStrokeGroup(key, label, p);
            }
        } catch (e) {}
    }

    function walk(parent, layerName, depth) {
        // Pathitems напрямую
        for (var i = 0; i < parent.pathItems.length; i++) {
            stats.path++;
            processPath(parent.pathItems[i], layerName);
        }
        // Compound paths
        for (var c = 0; c < parent.compoundPathItems.length; c++) {
            stats.compound++;
            var cp = parent.compoundPathItems[c];
            for (var k = 0; k < cp.pathItems.length; k++) {
                processPath(cp.pathItems[k], layerName);
            }
        }
        // Группы — рекурсивно
        for (var g = 0; g < parent.groupItems.length; g++) {
            stats.group++;
            walk(parent.groupItems[g], layerName, depth + 1);
        }
        // Text
        try { stats.text += parent.textFrames.length; } catch (e) {}
        // Placed / Raster / Symbol / Mesh
        try { stats.placed += parent.placedItems.length; } catch (e) {}
        try { stats.raster += parent.rasterItems.length; } catch (e) {}
        try { stats.symbol += parent.symbolItems.length; } catch (e) {}
        try { stats.mesh   += parent.meshItems.length;   } catch (e) {}
    }

    // ---------- Иерархия слоёв -----------------------------------------
    L("=== ИЕРАРХИЯ СЛОЁВ ===");
    function dumpLayer(layer, depth) {
        var pad = "";
        for (var d = 0; d < depth; d++) pad += "  ";
        var flags = [];
        if (!layer.visible) flags.push("hidden");
        if (layer.locked)   flags.push("locked");
        var flagStr = flags.length ? "  [" + flags.join(",") + "]" : "";
        var counts = " (paths=" + layer.pathItems.length +
                     ", compound=" + layer.compoundPathItems.length +
                     ", groups=" + layer.groupItems.length +
                     ", text=" + layer.textFrames.length +
                     ", placed=" + layer.placedItems.length +
                     ", raster=" + layer.rasterItems.length + ")";
        L(pad + "- \"" + layer.name + "\"" + flagStr + counts);
        for (var i = 0; i < layer.layers.length; i++) {
            dumpLayer(layer.layers[i], depth + 1);
        }
    }
    for (var li = 0; li < doc.layers.length; li++) {
        dumpLayer(doc.layers[li], 0);
    }
    L("");

    // ---------- Обход по всем слоям для статистики ---------------------
    for (var li2 = 0; li2 < doc.layers.length; li2++) {
        walk(doc.layers[li2], doc.layers[li2].name, 0);
    }

    // ---------- Статистика объектов ------------------------------------
    L("=== ОБЪЕКТЫ (всего по документу) ===");
    L("PathItems:           " + stats.path);
    L("CompoundPathItems:   " + stats.compound);
    L("GroupItems:          " + stats.group);
    L("TextFrames:          " + stats.text);
    L("PlacedItems:         " + stats.placed);
    L("RasterItems:         " + stats.raster);
    L("SymbolItems:         " + stats.symbol);
    L("MeshItems:           " + stats.mesh);
    L("");

    // ---------- Группы обводок (отсортированы по убыванию) -------------
    L("=== ОБВОДКИ (группировка по цвету) ===");
    strokeOrder.sort(function (a, b) {
        return strokeGroups[b].count - strokeGroups[a].count;
    });
    for (var si = 0; si < strokeOrder.length; si++) {
        var key = strokeOrder[si];
        var g = strokeGroups[key];
        var sw = g.sampleStrokeWidth != null
            ? "  strokeWidth=" + Math.round(g.sampleStrokeWidth * 100) / 100 + " pt"
            : "";
        var sb = g.sampleBoundsMm
            ? "  пример bbox: " + g.sampleBoundsMm.w + "x" + g.sampleBoundsMm.h + " мм"
            : "";
        L("[" + g.count + "] " + g.label + sw + sb);
    }
    L("");

    // ---------- Spot colors документа ----------------------------------
    L("=== SPOT COLORS В ДОКУМЕНТЕ ===");
    try {
        var spots = doc.spots;
        for (var sp = 0; sp < spots.length; sp++) {
            var s = spots[sp];
            L("- \"" + s.name + "\"  colorType=" + s.colorType);
        }
    } catch (e) {
        L("(не удалось прочитать spots: " + e + ")");
    }
    L("");

    // ---------- Сохраняем отчёт ----------------------------------------
    var outPath;
    try {
        outPath = doc.fullName.parent.fsName + "/" + doc.name + "__report.txt";
    } catch (eP) {
        outPath = Folder.desktop.fsName + "/" + doc.name + "__report.txt";
    }

    var f = new File(outPath);
    f.encoding = "UTF-8";
    if (f.open("w")) {
        f.write(lines.join("\n"));
        f.close();
        alert("Отчёт сохранён:\n" + outPath +
              "\n\nПерешли этот файл в чат с Claude.");
    } else {
        alert("Не удалось записать отчёт в:\n" + outPath);
    }

})();
