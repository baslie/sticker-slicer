/*
================================================================================
  StickerCore.jsx — общий движок экспорта стикеров (без UI)
================================================================================

  Только определения функций — НИКАКОГО исполняемого кода на верхнем уровне,
  чтобы файл можно было безопасно подключать через  //@include "StickerCore.jsx".

  Подключают оба скрипта:
    - StickerExporter.jsx  (интерактивный, один открытый документ);
    - BatchExporter.jsx    (пакетный, цикл по папке).

  Публичные функции:
    SC_collectStrokeGroups(doc) -> { groups, keysOrder }
        Сбор stroked-путей видимых незаблокированных слоёв, группировка по цвету.
    SC_pickCutCandidate(groups, keysOrder) -> chosenKey | null
        Авто-выбор контура реза: spot в приоритете, иначе самая массовая группа.
    SC_exportDoc(doc, chosenGroup, settings, excludeSet, outFolder, progressCb)
        -> { exported, total, sheets, sizesPath, sizesWritten, errors }
        Экспорт всех стикеров документа (PNG) + лист целиком (JPEG).
        UI нет — прогресс через progressCb(idx, total, label).
================================================================================
*/

var SC_MM2PT = 2.83464567;

// ============================================================================
//  Группировка обводок по цвету (для диалога и для авто-выбора реза)
// ============================================================================
function SC_collectStrokeGroups(doc) {
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
                var rc = Math.round(sc.cyan),  rm = Math.round(sc.magenta),
                    ry = Math.round(sc.yellow), rk = Math.round(sc.black);
                addToGroup("cmyk::" + rc + "," + rm + "," + ry + "," + rk, {
                    label: "CMYK(" + rc + "," + rm + "," + ry + "," + rk + ")",
                    kind: "cmyk", cmyk: { c: rc, m: rm, y: ry, k: rk }
                });
                continue;
            }
            if (sc.typename === "RGBColor") {
                var rr = Math.round(sc.red), rg = Math.round(sc.green),
                    rb = Math.round(sc.blue);
                addToGroup("rgb::" + rr + "," + rg + "," + rb, {
                    label: "RGB(" + rr + "," + rg + "," + rb + ")",
                    kind: "rgb", rgb: { r: rr, g: rg, b: rb }
                });
            }
        } catch (e) {}
    }

    return { groups: groups, keysOrder: keysOrder };
}

// ============================================================================
//  Авто-выбор контура реза: spot-группа в приоритете, иначе самая массовая
// ============================================================================
function SC_pickCutCandidate(groups, keysOrder) {
    var bestSpotKey = null, bestSpotCount = -1;
    var bestAnyKey  = null, bestAnyCount  = -1;
    for (var i = 0; i < keysOrder.length; i++) {
        var k = keysOrder[i], g = groups[k];
        if (g.count > bestAnyCount) { bestAnyCount = g.count; bestAnyKey = k; }
        if (g.kind === "spot" && g.count > bestSpotCount) {
            bestSpotCount = g.count; bestSpotKey = k;
        }
    }
    return bestSpotKey || bestAnyKey || null;
}

// ============================================================================
//  Экспорт всех стикеров одного документа
// ============================================================================
function SC_exportDoc(doc, chosenGroup, settings, excludeSet, outFolder, progressCb) {
    var TEMP_LAYER_NAME = "__TEMP_STICKER_EXPORT__";
    var MM2PT = SC_MM2PT;
    var whiteOutlinePt = settings.whiteOutlineMm * MM2PT;
    var paddingPt      = settings.paddingMm * MM2PT + whiteOutlinePt;

    // Лист целиком: по умолчанию включён, чистовой вариант (без линий реза).
    var doSheet       = (settings.exportSheet !== false);
    var sheetMode     = settings.sheetMode || "clean";   // "clean" | "raw" | "both"
    var sheetBaseName = settings.sheetFileName || "sheet";
    // Лист идёт в JPEG: PNG целого листа весит слишком много.
    var sheetQuality  = settings.sheetJpegQuality;
    if (isNaN(sheetQuality) || sheetQuality === null || sheetQuality === undefined) sheetQuality = 95;
    sheetQuality = Math.max(0, Math.min(100, sheetQuality));

    // ---------- Фильтр путей реза ---------------------------------------
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

    // ---------- Утилиты -------------------------------------------------
    function makeWhiteColor() {
        var c;
        if (doc.documentColorSpace === DocumentColorSpace.CMYK) {
            c = new CMYKColor(); c.cyan = 0; c.magenta = 0; c.yellow = 0; c.black = 0;
        } else {
            c = new RGBColor(); c.red = 255; c.green = 255; c.blue = 255;
        }
        return c;
    }
    function padNum(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }
    function ptToMm(pt)  { return pt / MM2PT; }
    function round1(x)   { return Math.round(x * 10) / 10; }

    function nowISO() {
        function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }
        var d = new Date();
        return d.getFullYear() + "-" + pad(d.getMonth() + 1, 2) + "-" +
               pad(d.getDate(), 2) + "T" + pad(d.getHours(), 2) + ":" +
               pad(d.getMinutes(), 2) + ":" + pad(d.getSeconds(), 2);
    }

    function toJSON(value, indent, level) {
        if (level === undefined) level = 0;
        var pad = ""; for (var pi = 0; pi < level; pi++) pad += indent;
        var pad2 = pad + indent;
        if (value === null || value === undefined) return "null";
        var t = typeof value;
        if (t === "number") return isFinite(value) ? String(value) : "null";
        if (t === "boolean") return value ? "true" : "false";
        if (t === "string") {
            var s = "\"";
            for (var ci = 0; ci < value.length; ci++) {
                var ch = value.charAt(ci), cc = value.charCodeAt(ci);
                if (ch === "\"") s += "\\\"";
                else if (ch === "\\") s += "\\\\";
                else if (ch === "\n") s += "\\n";
                else if (ch === "\r") s += "\\r";
                else if (ch === "\t") s += "\\t";
                else if (cc < 0x20) { var hex = cc.toString(16); while (hex.length < 4) hex = "0" + hex; s += "\\u" + hex; }
                else s += ch;
            }
            return s + "\"";
        }
        if (value instanceof Array) {
            if (value.length === 0) return "[]";
            var arr = [];
            for (var ai = 0; ai < value.length; ai++) arr.push(pad2 + toJSON(value[ai], indent, level + 1));
            return "[\n" + arr.join(",\n") + "\n" + pad + "]";
        }
        if (t === "object") {
            var keys = [];
            for (var k in value) if (value.hasOwnProperty(k)) keys.push(k);
            if (keys.length === 0) return "{}";
            var parts = [];
            for (var ki = 0; ki < keys.length; ki++) {
                var key = keys[ki];
                parts.push(pad2 + toJSON(key, indent, level + 1) + ": " + toJSON(value[key], indent, level + 1));
            }
            return "{\n" + parts.join(",\n") + "\n" + pad + "}";
        }
        return "null";
    }

    function bboxIntersect(a, b) {
        return !(a[2] < b[0] || a[0] > b[2] || a[3] > b[1] || a[1] < b[3]);
    }
    function boxArea(b) {
        try { return Math.abs((b[2] - b[0]) * (b[1] - b[3])); } catch (e) { return 0; }
    }
    // Видимые границы (учитывают клиппинг): обрезанная группа-стикер не затянет
    // в кадр соседа, чьё НЕобрезанное фото торчит в соседнюю ячейку.
    function itemBounds(it) {
        try { var vb = it.visibleBounds; if (vb) return vb; } catch (e) {}
        try { return it.geometricBounds; } catch (e2) {}
        return null;
    }
    function isPlainContainer(grp) {
        try { if (grp.clipped) return false; } catch (e) {}
        try { if (grp.opacity !== undefined && grp.opacity < 99.5) return false; } catch (e) {}
        try { if (grp.blendingMode !== undefined && grp.blendingMode !== BlendModes.NORMAL) return false; } catch (e) {}
        return true;
    }

    // Большие простые группы-контейнеры разбираем на детей (иначе O(n²)).
    function collectIntersectingItems(bbox, currentCutItem, layersToSkip) {
        var result = [];
        var cutArea = boxArea(bbox);
        function walk(parent) {
            for (var i = 0; i < parent.pageItems.length; i++) {
                var it = parent.pageItems[i];
                if (it === currentCutItem) continue;
                if (isCutItem(it)) continue;
                var ib = itemBounds(it);
                if (!ib) continue;
                if (!bboxIntersect(ib, bbox)) continue;
                if (it.typename === "GroupItem" && isPlainContainer(it) && boxArea(ib) > cutArea * 4) {
                    walk(it);
                } else {
                    result.push(it);
                }
            }
        }
        for (var l = 0; l < doc.layers.length; l++) {
            var lay = doc.layers[l];
            if (!lay.visible || lay.locked) continue;
            if (layersToSkip && layersToSkip[lay.name]) continue;
            walk(lay);
        }
        return result;
    }

    // Снять обводку cut-цвета у дублированной графики (линия реза могла быть
    // спрятана внутри группы стикера и проступила бы по краю PNG).
    function stripCutStrokes(container) {
        try {
            for (var i = 0; i < container.pathItems.length; i++) {
                if (isCutPath(container.pathItems[i])) {
                    try { container.pathItems[i].stroked = false; } catch (e) {}
                }
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
            for (var g = 0; g < container.groupItems.length; g++) stripCutStrokes(container.groupItems[g]);
        } catch (e) {}
    }

    // ---------- Сбор контуров реза --------------------------------------
    var cutPaths = [];
    for (var li2 = 0; li2 < doc.layers.length; li2++) {
        var layCut = doc.layers[li2];
        if (!layCut.visible || layCut.locked) continue;
        if (excludeSet[layCut.name]) continue;
        collectCut(layCut, cutPaths);
    }

    var errors = [], exported = 0, sizes = [], sheets = [], cutBoxes = [];

    // ---------- Опции экспорта PNG --------------------------------------
    var exportOpts = new ExportOptionsPNG24();
    exportOpts.transparency     = true;
    exportOpts.matte            = false;
    exportOpts.artBoardClipping = true;
    exportOpts.antiAliasing     = true;
    exportOpts.horizontalScale  = settings.exportScalePercent;
    exportOpts.verticalScale    = settings.exportScalePercent;

    // ---------- Опции экспорта листа (JPEG) -----------------------------
    // Прозрачности в JPEG нет: пустое поле листа заливается белым (matte).
    // Масштаб JPEG в Illustrator ограничен 776.19 % — подрезаем, чтобы не
    // ронять экспорт на больших значениях.
    var sheetScale = Math.min(settings.exportScalePercent, 776);
    var sheetOpts = new ExportOptionsJPEG();
    sheetOpts.qualitySetting   = sheetQuality;
    sheetOpts.antiAliasing     = true;
    sheetOpts.artBoardClipping = true;
    sheetOpts.optimization     = true;
    sheetOpts.blurAmount       = 0;
    sheetOpts.matte            = true;
    try { sheetOpts.matteColor = makeWhiteColor(); } catch (eMatte) {}
    sheetOpts.horizontalScale  = sheetScale;
    sheetOpts.verticalScale    = sheetScale;

    // ---------- Видимости слоёв (запомнить/восстановить) ----------------
    var origLayerVisibility = [];
    for (var lv = 0; lv < doc.layers.length; lv++) {
        origLayerVisibility.push({ layer: doc.layers[lv], visible: doc.layers[lv].visible, locked: doc.layers[lv].locked });
    }
    function restoreLayerVisibility() {
        for (var i = 0; i < origLayerVisibility.length; i++) {
            var ov = origLayerVisibility[i];
            try { ov.layer.visible = ov.visible; } catch (e) {}
            try { ov.layer.locked  = ov.locked;  } catch (e) {}
        }
    }

    // ====================================================================
    //  Лист целиком: PNG всего artboard теми же настройками, что и стикеры
    // ====================================================================

    // Запомнить свойство объекта, чтобы вернуть его после экспорта листа.
    function remember(list, obj, prop) {
        try { list.push({ obj: obj, prop: prop, value: obj[prop] }); } catch (e) {}
    }
    // Гасим обводку у живого пути: порядок важен — при восстановлении
    // (в обратном порядке) сначала вернётся stroked, потом цвет и толщина.
    function unstrokeReversible(path, undoList) {
        remember(undoList, path, "strokeWidth");
        remember(undoList, path, "strokeColor");
        remember(undoList, path, "stroked");
        try { path.stroked = false; } catch (e) {}
    }
    function restoreAll(list) {
        for (var i = list.length - 1; i >= 0; i--) {
            try { list[i].obj[list[i].prop] = list[i].value; } catch (e) {}
        }
    }

    // Снять обводку cut-цвета по всему контейнеру ОБРАТИМО: для листа линии
    // реза убираем из живого документа, а после экспорта возвращаем на место.
    // В отличие от stripCutStrokes заходит и в подслои (layer.layers).
    function stripCutStrokesTracked(container, undoList) {
        try {
            for (var i = 0; i < container.pathItems.length; i++) {
                var p = container.pathItems[i];
                if (!isCutPath(p)) continue;
                unstrokeReversible(p, undoList);
            }
        } catch (e1) {}
        try {
            for (var c = 0; c < container.compoundPathItems.length; c++) {
                var cp = container.compoundPathItems[c];
                for (var k = 0; k < cp.pathItems.length; k++) {
                    var cpp = cp.pathItems[k];
                    if (!isCutPath(cpp)) continue;
                    unstrokeReversible(cpp, undoList);
                }
            }
        } catch (e2) {}
        try {
            for (var g = 0; g < container.groupItems.length; g++) {
                var grp = container.groupItems[g];
                try { if (grp.locked) { remember(undoList, grp, "locked"); grp.locked = false; } } catch (e) {}
                stripCutStrokesTracked(grp, undoList);
            }
        } catch (e3) {}
        try {
            if (container.layers) {
                for (var sl = 0; sl < container.layers.length; sl++) {
                    var sub = container.layers[sl];
                    if (!sub.visible) continue;
                    if (sub.locked) { remember(undoList, sub, "locked"); try { sub.locked = false; } catch (e) {} }
                    stripCutStrokesTracked(sub, undoList);
                }
            }
        } catch (e4) {}
    }

    // Габарит всех контуров реза, попавших на этот artboard (в pt).
    function cutAreaOnArtboard(abRect) {
        var box = null;
        for (var i = 0; i < cutBoxes.length; i++) {
            var cb = cutBoxes[i];
            if (!bboxIntersect(cb, abRect)) continue;
            if (!box) { box = [cb[0], cb[1], cb[2], cb[3]]; continue; }
            box[0] = Math.min(box[0], cb[0]); box[1] = Math.max(box[1], cb[1]);
            box[2] = Math.max(box[2], cb[2]); box[3] = Math.min(box[3], cb[3]);
        }
        return box;
    }

    // mode: "clean" — без линий реза и без исключённых слоёв (как печатается);
    //       "raw"   — artboard как есть, со всем содержимым макета.
    function exportSheetVariant(mode) {
        var undoList = [];
        var savedAb = doc.artboards.getActiveArtboardIndex();
        try {
            if (mode === "clean") {
                for (var l = 0; l < doc.layers.length; l++) {
                    var lay = doc.layers[l];
                    if (excludeSet[lay.name]) { try { lay.visible = false; } catch (e) {} continue; }
                    if (!lay.visible) continue;
                    try { lay.locked = false; } catch (e) {}
                    stripCutStrokesTracked(lay, undoList);
                }
            }
            var many = doc.artboards.length > 1;
            for (var ai = 0; ai < doc.artboards.length; ai++) {
                var ab = doc.artboards[ai];
                var abRect = ab.artboardRect;
                doc.artboards.setActiveArtboardIndex(ai);

                var name = sheetBaseName + (mode === "raw" ? "_raw" : "") +
                           (many ? "_" + padNum(ai + 1, 2) : "") + ".jpg";
                doc.exportFile(new File(outFolder.fsName + "/" + name), ExportType.JPEG, sheetOpts);

                var rec = {
                    file: name,
                    mode: mode,
                    artboard: ab.name,
                    sheet_size_mm: { width:  round1(ptToMm(abRect[2] - abRect[0])),
                                     height: round1(ptToMm(abRect[1] - abRect[3])) }
                };
                var ca = cutAreaOnArtboard(abRect);
                if (ca) {
                    rec.stickers_area_mm = { width:  round1(ptToMm(ca[2] - ca[0])),
                                             height: round1(ptToMm(ca[1] - ca[3])) };
                }
                sheets.push(rec);
            }
        } catch (eSheet) {
            errors.push("лист (" + mode + "): " + eSheet);
        } finally {
            restoreAll(undoList);
            try { doc.artboards.setActiveArtboardIndex(savedAb); } catch (e) {}
            restoreLayerVisibility();
        }
    }

    function exportSheets() {
        if (!doSheet) return;
        if (progressCb) {
            try { progressCb(cutPaths.length, cutPaths.length, "Лист целиком…"); } catch (ePc) {}
        }
        if (sheetMode === "clean" || sheetMode === "both") exportSheetVariant("clean");
        if (sheetMode === "raw"   || sheetMode === "both") exportSheetVariant("raw");
    }

    // Реза нет — стикеров не будет, но лист выгрузить всё равно можно.
    if (cutPaths.length === 0) {
        errors.push("Контуры реза не найдены для выбранного цвета.");
        exportSheets();
        return { exported: 0, total: 0, sheets: sheets,
                 sizesPath: null, sizesWritten: false, errors: errors };
    }

    // ---------- Главный цикл --------------------------------------------
    for (var idx = 0; idx < cutPaths.length; idx++) {
        if (progressCb) { try { progressCb(idx, cutPaths.length); } catch (ePc) {} }
        var cutItem = cutPaths[idx];
        var tempLayer = null;
        var abIdx = -1;
        var savedActive = doc.artboards.getActiveArtboardIndex();

        try {
            var b = cutItem.geometricBounds;
            var rect = [ b[0] - paddingPt, b[1] + paddingPt, b[2] + paddingPt, b[3] - paddingPt ];
            cutBoxes.push([ b[0], b[1], b[2], b[3] ]);

            var cut_w_mm = round1(ptToMm(b[2] - b[0]));
            var cut_h_mm = round1(ptToMm(b[1] - b[3]));
            var wo_w_mm  = round1(cut_w_mm + 2 * settings.whiteOutlineMm);
            var wo_h_mm  = round1(cut_h_mm + 2 * settings.whiteOutlineMm);
            var png_w_mm = round1(cut_w_mm + 2 * (settings.whiteOutlineMm + settings.paddingMm));
            var png_h_mm = round1(cut_h_mm + 2 * (settings.whiteOutlineMm + settings.paddingMm));

            // 1) Временный слой наверху
            tempLayer = doc.layers.add();
            tempLayer.name = TEMP_LAYER_NAME;
            tempLayer.move(doc, ElementPlacement.PLACEATBEGINNING);

            // 2) Графика, пересекающая bbox контура
            var intersecting = collectIntersectingItems(b, cutItem, excludeSet);
            for (var ii = 0; ii < intersecting.length; ii++) {
                try { intersecting[ii].duplicate(tempLayer, ElementPlacement.PLACEATEND); }
                catch (eDup) {}
            }

            // 3) Убрать остаточные линии реза из дублированной графики
            stripCutStrokes(tempLayer);

            // 4) Белая подложка из контура
            var whiteBacking = cutItem.duplicate(tempLayer, ElementPlacement.PLACEATEND);
            if (whiteBacking.typename === "CompoundPathItem") {
                for (var wbi = 0; wbi < whiteBacking.pathItems.length; wbi++) {
                    var ch = whiteBacking.pathItems[wbi];
                    ch.filled = true; ch.fillColor = makeWhiteColor();
                    ch.stroked = true; ch.strokeWidth = whiteOutlinePt * 2; ch.strokeColor = makeWhiteColor();
                    try { ch.strokeJoin = StrokeJoin.ROUNDENDJOIN; } catch (e) {}
                }
            } else {
                whiteBacking.filled = true; whiteBacking.fillColor = makeWhiteColor();
                whiteBacking.stroked = true; whiteBacking.strokeWidth = whiteOutlinePt * 2;
                whiteBacking.strokeColor = makeWhiteColor();
                try { whiteBacking.strokeJoin = StrokeJoin.ROUNDENDJOIN; } catch (e) {}
            }
            whiteBacking.zOrder(ZOrderMethod.SENDTOBACK);

            // 5) Mask shape из контура (наверх)
            var maskShape = cutItem.duplicate(tempLayer, ElementPlacement.PLACEATBEGINNING);
            if (maskShape.typename === "CompoundPathItem") {
                for (var msi = 0; msi < maskShape.pathItems.length; msi++) {
                    maskShape.pathItems[msi].filled = false; maskShape.pathItems[msi].stroked = false;
                }
            } else { maskShape.filled = false; maskShape.stroked = false; }

            // 6) Clipping mask
            doc.selection = null;
            tempLayer.hasSelectedArtwork = true;
            app.executeMenuCommand("makeMask");
            doc.selection = null;

            // 7) Скрыть остальные слои
            for (var lh = 0; lh < doc.layers.length; lh++) {
                if (doc.layers[lh] !== tempLayer) { try { doc.layers[lh].visible = false; } catch (e) {} }
            }
            tempLayer.visible = true;

            // 8) Временный artboard
            doc.artboards.add(rect);
            abIdx = doc.artboards.length - 1;
            doc.artboards.setActiveArtboardIndex(abIdx);

            // 9) Экспорт PNG
            var fileName = settings.fileNamePrefix + padNum(idx + 1, 3) + ".png";
            doc.exportFile(new File(outFolder.fsName + "/" + fileName), ExportType.PNG24, exportOpts);
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
            if (abIdx >= 0) { try { doc.artboards.remove(abIdx); } catch (e) {} }
            try { doc.artboards.setActiveArtboardIndex(savedActive); } catch (e) {}
            if (tempLayer) {
                try {
                    tempLayer.locked = false; tempLayer.visible = true;
                    while (tempLayer.pageItems.length > 0) {
                        try { tempLayer.pageItems[0].remove(); } catch (e) { break; }
                    }
                    tempLayer.remove();
                } catch (e) {}
            }
            restoreLayerVisibility();
        }
    }
    if (progressCb) { try { progressCb(cutPaths.length, cutPaths.length); } catch (ePc) {} }

    // ---------- Лист целиком --------------------------------------------
    exportSheets();

    // ---------- sizes.json ----------------------------------------------
    var sizesPath = outFolder.fsName + "/" + settings.sizesFileName;
    var sizesWritten = false;
    try {
        var report = {
            document: doc.name,
            exported_at: nowISO(),
            settings: {
                white_outline_mm:     settings.whiteOutlineMm,
                padding_mm:           settings.paddingMm,
                export_scale_percent: settings.exportScalePercent,
                export_sheet:         doSheet,
                sheet_mode:           doSheet ? sheetMode : null,
                sheet_format:         doSheet ? "jpeg" : null,
                sheet_jpeg_quality:   doSheet ? sheetQuality : null
            },
            sheets:   sheets,
            stickers: sizes
        };
        var f = new File(sizesPath);
        f.encoding = "UTF-8";
        if (f.open("w")) { f.write(toJSON(report, "  ", 0)); f.close(); sizesWritten = true; }
        else errors.push("sizes.json: не удалось открыть файл на запись");
    } catch (eJson) { errors.push("sizes.json: " + eJson); }

    return { exported: exported, total: cutPaths.length, sheets: sheets,
             sizesPath: sizesPath, sizesWritten: sizesWritten, errors: errors };
}
