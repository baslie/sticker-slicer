/*
================================================================================
  StickerExporter.jsx (v3) — экспорт стикеров с clipping mask
================================================================================

  Что нового по сравнению с v2:
  - Каждый стикер экспортируется ИЗОЛИРОВАННО:
      * создаётся временный слой,
      * в него дублируются только нужные объекты (cut-контур + картинки,
        попадающие внутрь его bbox),
      * применяется clipping mask по форме cut-контура,
      * все остальные слои документа скрываются на время экспорта.
  - Это решает три проблемы v2:
      (1) соседние стикеры больше не попадают в кадр,
      (2) любой посторонний фон / подложка / артефакт в других слоях
          (включая чёрный фон под слоем PRINT, если он есть) исключается
          из финального PNG,
      (3) cut-линия (magenta) больше не остаётся в финальном PNG.
  - Прозрачность форсируется явно (transparency=true, matte=false).

  Установка / запуск — как у v2: File → Scripts → Other Script…
================================================================================
*/

#target illustrator

(function () {

    // ===== Настройки экспорта (можно менять) ============================
    var SETTINGS = {
        whiteOutlineMm:     2.5,
        paddingMm:          1.0,
        exportScalePercent: 200,
        fileNamePrefix:     "sticker_",
        sizesFileName:      "sizes.json"
    };
    var TEMP_LAYER_NAME = "__TEMP_STICKER_EXPORT__";
    // ====================================================================

    if (app.documents.length === 0) {
        alert("Откройте .ai файл и запустите скрипт снова.");
        return;
    }
    var doc = app.activeDocument;
    var MM2PT = 2.83464567;

    // ---------- Сбор всех stroked path items для диалога ----------------
    function collectAllStroked(parent, out) {
        for (var i = 0; i < parent.pathItems.length; i++) {
            var p = parent.pathItems[i];
            try { if (p.stroked) out.push(p); } catch (e) {}
        }
        for (var c = 0; c < parent.compoundPathItems.length; c++) {
            var cp = parent.compoundPathItems[c];
            for (var k = 0; k < cp.pathItems.length; k++) {
                try { if (cp.pathItems[k].stroked) out.push(cp.pathItems[k]); }
                catch (e) {}
            }
        }
        for (var g = 0; g < parent.groupItems.length; g++) {
            collectAllStroked(parent.groupItems[g], out);
        }
        return out;
    }

    var allStroked = [];
    for (var li = 0; li < doc.layers.length; li++) {
        if (!doc.layers[li].visible || doc.layers[li].locked) continue;
        collectAllStroked(doc.layers[li], allStroked);
    }
    if (allStroked.length === 0) {
        alert("Нет ни одного пути с обводкой. Проверь, что нужный слой\n" +
              "видимый и не заблокирован.");
        return;
    }

    // ---------- Группируем варианты обводок -----------------------------
    var groups = {}, keysOrder = [];
    function addToGroup(key, info) {
        if (!groups[key]) {
            groups[key] = {
                label:   info.label,
                count:   0,
                kind:    info.kind,
                spotRef: info.spotRef || null,
                cmyk:    info.cmyk    || null,
                rgb:     info.rgb     || null
            };
            keysOrder.push(key);
        }
        groups[key].count++;
    }
    for (var i = 0; i < allStroked.length; i++) {
        var p = allStroked[i];
        try {
            var sc = p.strokeColor;
            if (!sc) continue;
            if (sc.typename === "SpotColor" && sc.spot) {
                addToGroup("spot::" + sc.spot.name, {
                    label: 'Spot: "' + sc.spot.name + '"',
                    kind: "spot", spotRef: sc.spot
                });
                continue;
            }
            if (sc.typename === "CMYKColor") {
                var rc = Math.round(sc.cyan),
                    rm = Math.round(sc.magenta),
                    ry = Math.round(sc.yellow),
                    rk = Math.round(sc.black);
                addToGroup("cmyk::" + rc + "," + rm + "," + ry + "," + rk, {
                    label: "CMYK(" + rc + "," + rm + "," + ry + "," + rk + ")",
                    kind: "cmyk",
                    cmyk: { c: rc, m: rm, y: ry, k: rk }
                });
                continue;
            }
            if (sc.typename === "RGBColor") {
                var rr = Math.round(sc.red),
                    rg = Math.round(sc.green),
                    rb = Math.round(sc.blue);
                addToGroup("rgb::" + rr + "," + rg + "," + rb, {
                    label: "RGB(" + rr + "," + rg + "," + rb + ")",
                    kind: "rgb",
                    rgb: { r: rr, g: rg, b: rb }
                });
            }
        } catch (e) {}
    }

    if (keysOrder.length === 0) {
        alert("Не нашёл ни одной обводки в видимых незаблокированных слоях.");
        return;
    }

    // ---------- Диалог выбора + настройки -------------------------------
    var dlg = new Window("dialog", "Экспорт стикеров (v4)");
    dlg.orientation = "column";
    dlg.alignChildren = "fill";
    dlg.preferredSize.width = 460;

    dlg.add("statictext", undefined,
            "Выбери, какие линии — это контуры реза:",
            { multiline: true });

    keysOrder.sort(function (a, b) { return groups[b].count - groups[a].count; });
    var radios = [];
    for (var ki = 0; ki < keysOrder.length; ki++) {
        var k = keysOrder[ki], g = groups[k];
        var rb = dlg.add("radiobutton", undefined,
                         g.label + "  —  " + g.count + " путей");
        rb._key = k;
        if (ki === 0) rb.value = true;
        radios.push(rb);
    }

    var pnl = dlg.add("panel", undefined, "Параметры экспорта");
    pnl.orientation = "column"; pnl.alignChildren = "left"; pnl.margins = 12;
    function num(parent, label, def, suffix) {
        var r = parent.add("group");
        var l = r.add("statictext", undefined, label);
        l.preferredSize.width = 220;
        var e = r.add("edittext", undefined, String(def));
        e.preferredSize.width = 70;
        if (suffix) r.add("statictext", undefined, suffix);
        return e;
    }
    var edWhite = num(pnl, "Толщина белой подложки:",
                      SETTINGS.whiteOutlineMm, "мм");
    var edPad   = num(pnl, "Запас на artboard:",
                      SETTINGS.paddingMm, "мм");
    var edScale = num(pnl, "Масштаб PNG:",
                      SETTINGS.exportScalePercent, "%");

    // Поле «Исключить слои» — имена через запятую (например: MARKS CUT)
    var grpExcl = pnl.add("group");
    var lblExcl = grpExcl.add("statictext", undefined,
                              "Исключить слои (через запятую):");
    lblExcl.preferredSize.width = 220;
    var edExclude = grpExcl.add("edittext", undefined, "MARKS CUT");
    edExclude.preferredSize.width = 160;

    var btnRow = dlg.add("group");
    btnRow.alignment = "right";
    btnRow.add("button", undefined, "Отмена", { name: "cancel" });
    btnRow.add("button", undefined, "Экспортировать", { name: "ok" });

    if (dlg.show() !== 1) return;

    var chosenKey = null;
    for (var r = 0; r < radios.length; r++) {
        if (radios[r].value) { chosenKey = radios[r]._key; break; }
    }
    if (!chosenKey) return;
    var chosenGroup = groups[chosenKey];

    SETTINGS.whiteOutlineMm     = parseFloat(edWhite.text) || SETTINGS.whiteOutlineMm;
    SETTINGS.paddingMm          = parseFloat(edPad.text)   || SETTINGS.paddingMm;
    SETTINGS.exportScalePercent = parseFloat(edScale.text) || SETTINGS.exportScalePercent;

    // Парсим список исключаемых слоёв в объект-набор имён
    var excludeLayersSet = {};
    var exclParts = String(edExclude.text || "").split(",");
    for (var ex = 0; ex < exclParts.length; ex++) {
        var nm = exclParts[ex].replace(/^\s+|\s+$/g, "");
        if (nm.length > 0) excludeLayersSet[nm] = true;
    }

    var outFolder = Folder.selectDialog("Куда сохранить PNG?");
    if (!outFolder) return;

    var whiteOutlinePt = SETTINGS.whiteOutlineMm * MM2PT;
    var paddingPt      = SETTINGS.paddingMm * MM2PT + whiteOutlinePt;

    // ---------- Финальный фильтр путей ----------------------------------
    function isCutPath(p) {
        try {
            var sc = p.strokeColor;
            if (!sc) return false;
            if (chosenGroup.kind === "spot") {
                return sc.typename === "SpotColor" && sc.spot &&
                       sc.spot.name === chosenGroup.spotRef.name;
            }
            if (chosenGroup.kind === "cmyk") {
                if (sc.typename !== "CMYKColor") return false;
                var cg = chosenGroup.cmyk;
                return Math.round(sc.cyan)    === cg.c &&
                       Math.round(sc.magenta) === cg.m &&
                       Math.round(sc.yellow)  === cg.y &&
                       Math.round(sc.black)   === cg.k;
            }
            if (chosenGroup.kind === "rgb") {
                if (sc.typename !== "RGBColor") return false;
                var rg = chosenGroup.rgb;
                return Math.round(sc.red)   === rg.r &&
                       Math.round(sc.green) === rg.g &&
                       Math.round(sc.blue)  === rg.b;
            }
        } catch (e) {}
        return false;
    }

    function isCutItem(item) {
        if (!item) return false;
        if (item.typename === "PathItem") return isCutPath(item);
        if (item.typename === "CompoundPathItem") {
            for (var k = 0; k < item.pathItems.length; k++) {
                if (isCutPath(item.pathItems[k])) return true;
            }
        }
        return false;
    }

    function collectCut(parent, out) {
        for (var i = 0; i < parent.pathItems.length; i++) {
            if (isCutPath(parent.pathItems[i])) out.push(parent.pathItems[i]);
        }
        for (var c = 0; c < parent.compoundPathItems.length; c++) {
            var cp = parent.compoundPathItems[c];
            var f = false;
            for (var k = 0; k < cp.pathItems.length; k++) {
                if (isCutPath(cp.pathItems[k])) { f = true; break; }
            }
            if (f) out.push(cp);
        }
        for (var g = 0; g < parent.groupItems.length; g++) {
            collectCut(parent.groupItems[g], out);
        }
        return out;
    }

    var cutPaths = [];
    for (var li2 = 0; li2 < doc.layers.length; li2++) {
        var layCut = doc.layers[li2];
        if (!layCut.visible || layCut.locked) continue;
        if (excludeLayersSet[layCut.name]) continue;
        collectCut(layCut, cutPaths);
    }
    if (cutPaths.length === 0) { alert("Контуры не найдены."); return; }

    // ---------- Утилиты экспорта ----------------------------------------
    function makeWhiteColor() {
        var c;
        if (doc.documentColorSpace === DocumentColorSpace.CMYK) {
            c = new CMYKColor();
            c.cyan = 0; c.magenta = 0; c.yellow = 0; c.black = 0;
        } else {
            c = new RGBColor();
            c.red = 255; c.green = 255; c.blue = 255;
        }
        return c;
    }
    function padNum(n, w) {
        var s = String(n);
        while (s.length < w) s = "0" + s;
        return s;
    }
    function ptToMm(pt)  { return pt / MM2PT; }
    function round1(x)   { return Math.round(x * 10) / 10; }

    // ExtendScript (ES3) не имеет Date.prototype.toISOString — пишем сами
    function nowISO() {
        function pad(n, w) {
            var s = String(n);
            while (s.length < w) s = "0" + s;
            return s;
        }
        var d = new Date();
        return d.getFullYear() + "-" +
               pad(d.getMonth() + 1, 2) + "-" +
               pad(d.getDate(), 2) + "T" +
               pad(d.getHours(), 2) + ":" +
               pad(d.getMinutes(), 2) + ":" +
               pad(d.getSeconds(), 2);
    }

    // Минимальный JSON-сериализатор: ExtendScript не имеет нативного JSON.stringify
    function toJSON(value, indent, level) {
        if (level === undefined) level = 0;
        var pad = "";
        for (var pi = 0; pi < level; pi++) pad += indent;
        var pad2 = pad + indent;

        if (value === null || value === undefined) return "null";
        var t = typeof value;
        if (t === "number") {
            return isFinite(value) ? String(value) : "null";
        }
        if (t === "boolean") return value ? "true" : "false";
        if (t === "string") {
            var s = "\"";
            for (var ci = 0; ci < value.length; ci++) {
                var ch = value.charAt(ci);
                var cc = value.charCodeAt(ci);
                if (ch === "\"")      s += "\\\"";
                else if (ch === "\\") s += "\\\\";
                else if (ch === "\n") s += "\\n";
                else if (ch === "\r") s += "\\r";
                else if (ch === "\t") s += "\\t";
                else if (cc < 0x20) {
                    var hex = cc.toString(16);
                    while (hex.length < 4) hex = "0" + hex;
                    s += "\\u" + hex;
                } else s += ch;
            }
            return s + "\"";
        }
        if (value instanceof Array) {
            if (value.length === 0) return "[]";
            var arr = [];
            for (var ai = 0; ai < value.length; ai++) {
                arr.push(pad2 + toJSON(value[ai], indent, level + 1));
            }
            return "[\n" + arr.join(",\n") + "\n" + pad + "]";
        }
        if (t === "object") {
            var keys = [];
            for (var k in value) {
                if (value.hasOwnProperty(k)) keys.push(k);
            }
            if (keys.length === 0) return "{}";
            var parts = [];
            for (var ki = 0; ki < keys.length; ki++) {
                var key = keys[ki];
                parts.push(pad2 + toJSON(key, indent, level + 1) +
                           ": " + toJSON(value[key], indent, level + 1));
            }
            return "{\n" + parts.join(",\n") + "\n" + pad + "}";
        }
        return "null";
    }

    // bbox: [L, T, R, B] в Illustrator координатах (Y растёт вверх, T > B)
    function bboxIntersect(a, b) {
        return !(a[2] < b[0] || a[0] > b[2] || a[3] > b[1] || a[1] < b[3]);
    }

    // Площадь bbox в pt² — для оценки «группа сильно больше контура»
    function boxArea(b) {
        try { return Math.abs((b[2] - b[0]) * (b[1] - b[3])); } catch (e) { return 0; }
    }

    // ВИДИМЫЕ границы объекта (учитывают клиппинг). Для обрезанной группы
    // geometricBounds возвращает размер НЕобрезанной картинки — она может
    // торчать в соседнюю ячейку и затягивать соседний стикер в кадр.
    // visibleBounds возвращает размер с учётом обрезки — то, что реально видно.
    function itemBounds(it) {
        try { var vb = it.visibleBounds; if (vb) return vb; } catch (e) {}
        try { return it.geometricBounds; } catch (e2) {}
        return null;
    }

    // Группа без собственного оформления, которую безопасно «разобрать» на
    // детей: их геометрия в координатах документа не меняется. Клиппинг,
    // прозрачность и blend-режим на уровне группы — разбирать НЕЛЬЗЯ (потеряем
    // обрезку/вид), такие группы дублируем целиком.
    function isPlainContainer(grp) {
        try { if (grp.clipped) return false; } catch (e) {}
        try { if (grp.opacity !== undefined && grp.opacity < 99.5) return false; } catch (e) {}
        try {
            if (grp.blendingMode !== undefined &&
                grp.blendingMode !== BlendModes.NORMAL) return false;
        } catch (e) {}
        return true;
    }

    // Найти pageItems, пересекающие bbox. Большие простые группы-контейнеры
    // разбираем рекурсивно на детей — иначе на каждый из сотен контуров
    // дублировалась бы вся графика листа (O(n²), очень медленно на тяжёлых .ai).
    function collectIntersectingItems(bbox, currentCutItem, layersToSkip) {
        var result = [];
        var cutArea = boxArea(bbox);
        function walk(parent) {
            for (var i = 0; i < parent.pageItems.length; i++) {
                var it = parent.pageItems[i];
                if (it === currentCutItem) continue;
                // соседние cut-контуры — пропустить
                if (isCutItem(it)) continue;
                var ib = itemBounds(it);
                if (!ib) continue;
                if (!bboxIntersect(ib, bbox)) continue;
                // Разбираем только заметно большие простые группы; мелкие
                // (по-стикерные) и любые с оформлением берём целиком.
                if (it.typename === "GroupItem" &&
                    isPlainContainer(it) &&
                    boxArea(ib) > cutArea * 4) {
                    walk(it);
                } else {
                    result.push(it);
                }
            }
        }
        for (var l = 0; l < doc.layers.length; l++) {
            var lay = doc.layers[l];
            if (!lay.visible) continue;
            if (lay.locked)   continue;
            if (layersToSkip && layersToSkip[lay.name]) continue;
            walk(lay);
        }
        return result;
    }

    // Снять обводку cut-цвета у всей графики во временном слое. Нужна потому,
    // что линия реза может быть спрятана ВНУТРИ группы стикера: тогда группа
    // дублируется целиком, и без зачистки magenta-линия реза проступила бы по
    // краю PNG. Заливку не трогаем (magenta-заливка может быть частью дизайна).
    function stripCutStrokes(container) {
        try {
            for (var i = 0; i < container.pathItems.length; i++) {
                var p = container.pathItems[i];
                if (isCutPath(p)) { try { p.stroked = false; } catch (e) {} }
            }
        } catch (e) {}
        try {
            for (var c = 0; c < container.compoundPathItems.length; c++) {
                var cp = container.compoundPathItems[c];
                for (var k = 0; k < cp.pathItems.length; k++) {
                    if (isCutPath(cp.pathItems[k])) {
                        try { cp.pathItems[k].stroked = false; } catch (e) {}
                    }
                }
            }
        } catch (e) {}
        try {
            for (var g = 0; g < container.groupItems.length; g++)
                stripCutStrokes(container.groupItems[g]);
        } catch (e) {}
    }

    // ---------- Опции экспорта PNG --------------------------------------
    var exportOpts = new ExportOptionsPNG24();
    exportOpts.transparency     = true;
    exportOpts.matte            = false;        // ⬅ чтобы прозрачность сохранилась
    exportOpts.artBoardClipping = true;
    exportOpts.antiAliasing     = true;
    exportOpts.horizontalScale  = SETTINGS.exportScalePercent;
    exportOpts.verticalScale    = SETTINGS.exportScalePercent;

    // ---------- Прогресс -------------------------------------------------
    var win = new Window("palette", "Экспорт стикеров",
                         undefined, { closeButton: false });
    win.preferredSize.width = 380;
    win.add("statictext", undefined,
            "Найдено: " + cutPaths.length + " контуров.");
    var bar = win.add("progressbar", undefined, 0, cutPaths.length);
    bar.preferredSize.width = 340;
    var status = win.add("statictext", undefined,
                         "Стикер 0 / " + cutPaths.length);
    status.preferredSize.width = 340;
    win.show();

    // ---------- Запоминаем видимости всех слоёв (один раз) -------------
    var origLayerVisibility = [];
    for (var lv = 0; lv < doc.layers.length; lv++) {
        origLayerVisibility.push({
            layer: doc.layers[lv],
            visible: doc.layers[lv].visible,
            locked: doc.layers[lv].locked
        });
    }
    function restoreLayerVisibility() {
        for (var i = 0; i < origLayerVisibility.length; i++) {
            var ov = origLayerVisibility[i];
            try { ov.layer.visible = ov.visible; } catch (e) {}
            try { ov.layer.locked  = ov.locked;  } catch (e) {}
        }
    }

    var errors = [], exported = 0, sizes = [];

    // ---------- Главный цикл -------------------------------------------
    for (var idx = 0; idx < cutPaths.length; idx++) {
        var cutItem = cutPaths[idx];
        status.text = "Стикер " + (idx + 1) + " / " + cutPaths.length;
        bar.value = idx;
        win.update();

        var tempLayer = null;
        var abIdx = -1;
        var savedActive = doc.artboards.getActiveArtboardIndex();

        try {
            var b = cutItem.geometricBounds;
            var rect = [
                b[0] - paddingPt, b[1] + paddingPt,
                b[2] + paddingPt, b[3] - paddingPt
            ];

            // Размеры стикера в мм (cut-контур, +белая подложка, полный PNG)
            var cut_w_mm = round1(ptToMm(b[2] - b[0]));
            var cut_h_mm = round1(ptToMm(b[1] - b[3]));
            var wo_w_mm  = round1(cut_w_mm + 2 * SETTINGS.whiteOutlineMm);
            var wo_h_mm  = round1(cut_h_mm + 2 * SETTINGS.whiteOutlineMm);
            var png_w_mm = round1(cut_w_mm + 2 * (SETTINGS.whiteOutlineMm + SETTINGS.paddingMm));
            var png_h_mm = round1(cut_h_mm + 2 * (SETTINGS.whiteOutlineMm + SETTINGS.paddingMm));

            // 1) Создаём временный слой на самом верху
            tempLayer = doc.layers.add();
            tempLayer.name = TEMP_LAYER_NAME;
            tempLayer.move(doc, ElementPlacement.PLACEATBEGINNING);

            // 2) Все нужные объекты с других слоёв (картинки, попадающие в bbox)
            var intersecting = collectIntersectingItems(b, cutItem, excludeLayersSet);

            // 3) Дублируем картинки в tempLayer (в порядке снизу вверх)
            for (var ii = 0; ii < intersecting.length; ii++) {
                try {
                    intersecting[ii].duplicate(tempLayer,
                        ElementPlacement.PLACEATEND);
                } catch (eDup) {
                    // некоторые объекты могут отказаться дублироваться —
                    // не падаем, продолжаем
                }
            }

            // 3.5) Снять обводку cut-цвета у дублированной графики — иначе
            //      линия реза, спрятанная внутри группы стикера, проступит в PNG.
            stripCutStrokes(tempLayer);

            // 4) Дублируем cut-контур → белая подложка (под картинками)
            var whiteBacking = cutItem.duplicate(tempLayer,
                ElementPlacement.PLACEATEND);
            var wb = (whiteBacking.typename === "CompoundPathItem")
                ? whiteBacking.pathItems[0] // для compound установим стиль на детях
                : whiteBacking;
            // для CompoundPath проще пройти по всем детям
            if (whiteBacking.typename === "CompoundPathItem") {
                for (var wbi = 0; wbi < whiteBacking.pathItems.length; wbi++) {
                    var ch = whiteBacking.pathItems[wbi];
                    ch.filled = true;
                    ch.fillColor = makeWhiteColor();
                    ch.stroked = true;
                    ch.strokeWidth = whiteOutlinePt * 2;
                    ch.strokeColor = makeWhiteColor();
                    try { ch.strokeJoin = StrokeJoin.ROUNDENDJOIN; } catch (e) {}
                }
            } else {
                whiteBacking.filled = true;
                whiteBacking.fillColor = makeWhiteColor();
                whiteBacking.stroked = true;
                whiteBacking.strokeWidth = whiteOutlinePt * 2;
                whiteBacking.strokeColor = makeWhiteColor();
                try { whiteBacking.strokeJoin = StrokeJoin.ROUNDENDJOIN; } catch (e) {}
            }
            // отправляем подложку под все остальные объекты temp-слоя
            whiteBacking.zOrder(ZOrderMethod.SENDTOBACK);

            // 5) Дублируем cut-контур → mask shape (наверх)
            var maskShape = cutItem.duplicate(tempLayer,
                ElementPlacement.PLACEATBEGINNING);
            // для clipping mask заливка/обводка не важны
            if (maskShape.typename === "CompoundPathItem") {
                for (var msi = 0; msi < maskShape.pathItems.length; msi++) {
                    maskShape.pathItems[msi].filled = false;
                    maskShape.pathItems[msi].stroked = false;
                }
            } else {
                maskShape.filled = false;
                maskShape.stroked = false;
            }

            // 6) Применяем clipping mask:
            //    выделяем ВСЁ в tempLayer и зовём menuCommand "makeMask"
            doc.selection = null;
            tempLayer.hasSelectedArtwork = true;  // выделить всё в слое
            app.executeMenuCommand("makeMask");
            doc.selection = null;

            // 7) Скрываем все остальные слои
            for (var lh = 0; lh < doc.layers.length; lh++) {
                if (doc.layers[lh] !== tempLayer) {
                    try { doc.layers[lh].visible = false; } catch (e) {}
                }
            }
            tempLayer.visible = true;

            // 8) Создаём временный artboard
            doc.artboards.add(rect);
            abIdx = doc.artboards.length - 1;
            doc.artboards.setActiveArtboardIndex(abIdx);

            // 9) Экспорт
            var fileName = SETTINGS.fileNamePrefix +
                           padNum(idx + 1, 3) + ".png";
            doc.exportFile(new File(outFolder.fsName + "/" + fileName),
                           ExportType.PNG24, exportOpts);
            exported++;

            sizes.push({
                file: fileName,
                cut_size_mm:           { width: cut_w_mm, height: cut_h_mm },
                with_white_outline_mm: { width: wo_w_mm,  height: wo_h_mm  },
                png_size_mm:           { width: png_w_mm, height: png_h_mm }
            });

        } catch (err) {
            errors.push("#" + (idx + 1) + ": " + err);
        } finally {
            // Откат — в обратном порядке
            if (abIdx >= 0) {
                try { doc.artboards.remove(abIdx); } catch (e) {}
            }
            try { doc.artboards.setActiveArtboardIndex(savedActive); } catch (e) {}

            // Удаляем временный слой со всем содержимым
            if (tempLayer) {
                try {
                    tempLayer.locked = false;
                    tempLayer.visible = true;
                    // удалить всё содержимое слоя, потом сам слой
                    while (tempLayer.pageItems.length > 0) {
                        try { tempLayer.pageItems[0].remove(); } catch (e) { break; }
                    }
                    tempLayer.remove();
                } catch (e) {}
            }

            // Восстанавливаем видимости
            restoreLayerVisibility();
        }
    }

    bar.value = cutPaths.length;
    win.close();

    // ---------- Запись sizes.json ---------------------------------------
    var sizesPath = outFolder.fsName + "/" + SETTINGS.sizesFileName;
    var sizesWritten = false;
    try {
        var report = {
            document: doc.name,
            exported_at: nowISO(),
            settings: {
                white_outline_mm:     SETTINGS.whiteOutlineMm,
                padding_mm:           SETTINGS.paddingMm,
                export_scale_percent: SETTINGS.exportScalePercent
            },
            stickers: sizes
        };
        var jsonText = toJSON(report, "  ", 0);
        var f = new File(sizesPath);
        f.encoding = "UTF-8";
        if (f.open("w")) {
            f.write(jsonText);
            f.close();
            sizesWritten = true;
        } else {
            errors.push("sizes.json: не удалось открыть файл на запись");
        }
    } catch (eJson) {
        errors.push("sizes.json: " + eJson);
    }

    var msg = "Готово!\n\nЭкспортировано: " + exported + " / " +
              cutPaths.length + "\nПапка: " + outFolder.fsName;
    if (sizesWritten) {
        msg += "\nРазмеры: " + sizesPath;
    }
    if (errors.length) {
        msg += "\n\nОшибок: " + errors.length + "\n" +
               errors.slice(0, 5).join("\n");
        if (errors.length > 5) msg += "\n…ещё " + (errors.length - 5);
    }
    alert(msg);

})();