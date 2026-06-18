/*
================================================================================
  FixClipCut.jsx — сделать невидимый контур реза видимым для StickerExporter
================================================================================

  Зачем: в некоторых макетах (напр. NAKL_KOTYKI_135) контур реза задан НЕ
  обводкой, а невидимым замкнутым путём — clipping-путём обрезанной группы
  стикера (без заливки и без обводки). StickerExporter ищет рез только по
  обводке и такой контур не видит.

  Что делает (по активному документу):
  - Создаёт (или находит) spot-цвет "CutContour" — отдельный, чтобы группа
    реза в экспортёре была чистой и не смешивалась с посторонними линиями.
  - Проходит по всем верхнеуровневым группам видимых незаблокированных слоёв.
  - В каждой группе находит контур-обводку стикера:
      1) clipping-путь, если группа обрезана (group.clipped);
      2) иначе — самый крупный ЗАМКНУТЫЙ путь БЕЗ заливки и БЕЗ обводки
         (сигнатура невидимого дилайна).
  - Навешивает на него обводку цветом "CutContour" (0.25 pt). Видимая графика
    стикера не меняется — добавляется только тонкая линия реза.
  - Сохраняет КОПИЮ рядом: <имя>__cut.ai. Оригинал на диске не трогается.

  Дальше: открыть <имя>__cut.ai, запустить StickerExporter и выбрать в диалоге
  контур реза = Spot "CutContour".

  Запуск: открыть проблемный .ai → File → Scripts → Other Script… → этот файл.
================================================================================
*/

#target illustrator

(function () {

    if (app.documents.length === 0) {
        alert("Открой проблемный .ai (напр. NAKL_KOTYKI_135.ai) и запусти снова.");
        return;
    }
    var doc = app.activeDocument;
    var STROKE_WIDTH_PT = 0.25;
    var SPOT_NAME = "CutContour";

    function boxArea(b) {
        try { return Math.abs((b[2] - b[0]) * (b[1] - b[3])); } catch (e) { return 0; }
    }

    // ---------- Spot-цвет "CutContour" (создать или найти) --------------
    function ensureCutSpot() {
        // найти существующий
        for (var i = 0; i < doc.spots.length; i++) {
            if (doc.spots[i].name === SPOT_NAME) return doc.spots[i];
        }
        var spot = doc.spots.add();
        spot.name = SPOT_NAME;
        var inner;
        if (doc.documentColorSpace === DocumentColorSpace.CMYK) {
            inner = new CMYKColor();
            inner.cyan = 0; inner.magenta = 100; inner.yellow = 0; inner.black = 0;
        } else {
            inner = new RGBColor();
            inner.red = 255; inner.green = 0; inner.blue = 255;
        }
        spot.color = inner;
        try { spot.colorType = ColorModel.SPOT; } catch (e) {}
        return spot;
    }
    function makeSpotColor(spot) {
        var sc = new SpotColor();
        sc.spot = spot;
        sc.tint = 100;
        return sc;
    }

    // ---------- Поиск контура-обводки внутри группы ---------------------
    function isInvisibleClosed(it) {
        try {
            if (it.typename !== "PathItem") return false;
            if (!it.closed) return false;
            if (it.filled) return false;
            if (it.stroked) return false;
            return true;
        } catch (e) { return false; }
    }

    function findOutline(grp) {
        // 1) clipping-путь обрезанной группы
        try {
            if (grp.clipped) {
                for (var i = 0; i < grp.pageItems.length; i++) {
                    var it = grp.pageItems[i];
                    try {
                        if ((it.typename === "PathItem" ||
                             it.typename === "CompoundPathItem") && it.clipping) {
                            return it;
                        }
                    } catch (e) {}
                }
            }
        } catch (e) {}
        // 2) самый крупный невидимый замкнутый путь (сигнатура дилайна)
        var best = null, bestArea = 0;
        try {
            for (var p = 0; p < grp.pathItems.length; p++) {
                var pi = grp.pathItems[p];
                if (!isInvisibleClosed(pi)) continue;
                var a = 0;
                try { a = boxArea(pi.geometricBounds); } catch (e) {}
                if (a > bestArea) { bestArea = a; best = pi; }
            }
        } catch (e) {}
        return best;
    }

    function alreadyStroked(it) {
        try {
            if (it.typename === "CompoundPathItem") {
                for (var k = 0; k < it.pathItems.length; k++)
                    if (it.pathItems[k].stroked) return true;
                return false;
            }
            return it.stroked;
        } catch (e) { return false; }
    }

    function applyStroke(it, sc) {
        function one(p) {
            p.stroked = true;
            p.strokeColor = sc;
            p.strokeWidth = STROKE_WIDTH_PT;
            try { p.strokeJoin = StrokeJoin.ROUNDENDJOIN; } catch (e) {}
        }
        if (it.typename === "CompoundPathItem") {
            for (var k = 0; k < it.pathItems.length; k++) one(it.pathItems[k]);
        } else {
            one(it);
        }
    }

    // ---------- Основной проход -----------------------------------------
    var spot = ensureCutSpot();
    var sc = makeSpotColor(spot);

    var stroked = 0, skippedNoOutline = 0, skippedAlready = 0, groupsTotal = 0;

    for (var li = 0; li < doc.layers.length; li++) {
        var lay = doc.layers[li];
        if (!lay.visible || lay.locked) continue;
        for (var gi = 0; gi < lay.groupItems.length; gi++) {
            // только верхнеуровневые группы слоя (стикеры)
            var grp = lay.groupItems[gi];
            try { if (grp.parent.typename === "GroupItem") continue; } catch (e) {}
            groupsTotal++;
            var outline = findOutline(grp);
            if (!outline) { skippedNoOutline++; continue; }
            if (alreadyStroked(outline)) { skippedAlready++; continue; }
            try { applyStroke(outline, sc); stroked++; }
            catch (e) { skippedNoOutline++; }
        }
    }

    if (stroked === 0) {
        alert("Не нашёл невидимых контуров реза в группах.\n\n" +
              "Групп просмотрено: " + groupsTotal +
              "\nбез контура: " + skippedNoOutline +
              "\nуже с обводкой: " + skippedAlready +
              "\n\nВозможно, у этого файла другая структура — пришли inspect-отчёт.");
        return;
    }

    // ---------- Сохранить копию __cut.ai --------------------------------
    var savedPath = null;
    try {
        var base = doc.name.replace(/\.ai$/i, "");
        var folder = doc.fullName.parent.fsName;
        var newFile = new File(folder + "/" + base + "__cut.ai");
        var opts = new IllustratorSaveOptions();
        opts.pdfCompatible = true;
        doc.saveAs(newFile, opts);
        savedPath = newFile.fsName;
    } catch (eSave) {
        alert("Обводки навешены (" + stroked + "), но сохранить копию не удалось:\n" +
              eSave + "\n\nСохрани файл вручную как <имя>__cut.ai.");
        return;
    }

    alert("Готово.\n\n" +
          "Навешено обводок реза: " + stroked +
          "\nГрупп просмотрено: " + groupsTotal +
          (skippedNoOutline ? "\n  без контура (пропущено): " + skippedNoOutline : "") +
          (skippedAlready ? "\n  уже с обводкой (пропущено): " + skippedAlready : "") +
          "\n\nКопия сохранена:\n" + savedPath +
          "\n\nТеперь запусти StickerExporter на этом файле и выбери\n" +
          "контур реза = Spot \"" + SPOT_NAME + "\".");

})();
