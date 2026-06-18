/*
================================================================================
  PreflightBatch.jsx — пакетная проверка макетов перед StickerExporter
================================================================================

  Назначение:
  - Пройти ПАКЕТОМ по всем .ai в выбранной папке (открыть → проверить →
    закрыть без сохранения).
  - Для каждого файла проверить ровно тот контракт, на который опирается
    StickerExporter.jsx, и выдать явный вердикт PASS / WARN / FAIL.
  - Записать общий машиночитаемый preflight.json + человекочитаемый
    preflight.txt в выбранную папку.

  Что проверяется (контракт экспортёра):
    1. Есть ли stroked-пути на ВИДИМЫХ и НЕзаблокированных слоях верхнего
       уровня — только их видит экспортёр (StickerExporter.jsx:67-68, 272-277).
    2. Какие есть группы обводок (spot / CMYK / RGB) и какая — кандидат на
       контур реза (эвристика: spot в приоритете, иначе самая многочисленная).
    3. Сколько контуров-кандидатов реза найдено и бьётся ли это с числом,
       зашитым в имени файла (МЯГКАЯ подсказка, не вердикт).
    4. Не лежит ли контур реза на скрытом/заблокированном слое — тогда
       экспортёр найдёт 0 контуров.
    5. БЛИНДСПОТ экспортёра: stroked-пути в ПОДслоях (layer.layers).
       collectAllStroked не заходит в подслои — если резы там, экспортёр их
       не увидит. Считаем такие пути отдельно и предупреждаем.
    6. Неоднозначность cut-цвета: несколько сопоставимых stroke-групп =
       возможный «развал» одного реза на разные CMYK-значения.
    7. Подозрение на фон во весь лист (объект с bbox ≈ artboard) на не-cut
       слое — он попадёт фоном под каждый стикер.
    8. Есть ли вообще картинки (raster/placed) — иначе стикеры выйдут пустыми.
    9. Замкнуты ли контуры-кандидаты (открытые плохо работают как clipping mask).

  Запуск: File → Scripts → Other Script… → PreflightBatch.jsx
          → выбрать папку с макетами (например, Desktop/Макеты).
================================================================================
*/

#target illustrator

(function () {

    var MM2PT = 2.83464567;
    function ptToMm(pt) { return Math.round((pt / MM2PT) * 100) / 100; }

    // Полнолистовой объект считаем фоном, если он покрывает >= этой доли artboard
    var FULLSHEET_RATIO = 0.9;

    // ---------- Выбор папки с макетами ---------------------------------
    var inFolder = Folder.selectDialog(
        "Выбери папку с .ai-макетами (проверим все файлы пакетом)");
    if (!inFolder) return;

    var aiFiles = inFolder.getFiles(function (f) {
        return (f instanceof File) && /\.ai$/i.test(f.name);
    });
    if (!aiFiles || aiFiles.length === 0) {
        alert("В папке нет .ai-файлов:\n" + inFolder.fsName);
        return;
    }

    // ---------- JSON-сериализатор (ES3 без нативного JSON) -------------
    function toJSON(value, indent, level) {
        if (level === undefined) level = 0;
        var pad = "";
        for (var pi = 0; pi < level; pi++) pad += indent;
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
            for (var ai = 0; ai < value.length; ai++)
                arr.push(pad2 + toJSON(value[ai], indent, level + 1));
            return "[\n" + arr.join(",\n") + "\n" + pad + "]";
        }
        if (t === "object") {
            var keys = [];
            for (var k in value) if (value.hasOwnProperty(k)) keys.push(k);
            if (keys.length === 0) return "{}";
            var parts = [];
            for (var ki = 0; ki < keys.length; ki++) {
                var key = keys[ki];
                parts.push(pad2 + toJSON(key, indent, level + 1) + ": " +
                           toJSON(value[key], indent, level + 1));
            }
            return "{\n" + parts.join(",\n") + "\n" + pad + "}";
        }
        return "null";
    }

    function nowISO() {
        function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }
        var d = new Date();
        return d.getFullYear() + "-" + pad(d.getMonth() + 1, 2) + "-" +
               pad(d.getDate(), 2) + "T" + pad(d.getHours(), 2) + ":" +
               pad(d.getMinutes(), 2) + ":" + pad(d.getSeconds(), 2);
    }

    // Последняя группа цифр в имени файла — мягкая подсказка о числе стикеров
    function filenameNumber(name) {
        var base = name.replace(/\.ai$/i, "");
        var m = base.match(/(\d+)/g);
        if (!m || m.length === 0) return null;
        return parseInt(m[m.length - 1], 10);
    }

    // ---------- Описание / ключ цвета обводки (как в экспортёре) --------
    function strokeKeyLabel(sc) {
        if (!sc) return null;
        try {
            if (sc.typename === "SpotColor" && sc.spot) {
                return { key: "spot::" + sc.spot.name,
                         label: 'Spot: "' + sc.spot.name + '"', kind: "spot" };
            }
            if (sc.typename === "CMYKColor") {
                var c = Math.round(sc.cyan), m = Math.round(sc.magenta),
                    y = Math.round(sc.yellow), k = Math.round(sc.black);
                return { key: "cmyk::" + c + "," + m + "," + y + "," + k,
                         label: "CMYK(" + c + "," + m + "," + y + "," + k + ")",
                         kind: "cmyk" };
            }
            if (sc.typename === "RGBColor") {
                var r = Math.round(sc.red), g = Math.round(sc.green),
                    b = Math.round(sc.blue);
                return { key: "rgb::" + r + "," + g + "," + b,
                         label: "RGB(" + r + "," + g + "," + b + ")", kind: "rgb" };
            }
            return { key: "other::" + sc.typename, label: sc.typename, kind: "other" };
        } catch (e) { return null; }
    }

    // ================= Анализ одного документа =========================
    function analyzeDoc(doc) {
        var rec = {
            file: doc.name,
            colorSpace: String(doc.documentColorSpace),
            artboards: [],
            layersTop: [],
            strokeGroups: [],     // отсортированы по countSeen
            candidateCut: null,
            filenameNumber: filenameNumber(doc.name),
            strokesInSublayers: 0,
            suspectedFullSheet: [],
            imagesCount: 0,
            checks: [],
            verdict: "PASS"
        };

        // --- Artboards ---
        var maxAbW = 0, maxAbH = 0;
        for (var ai = 0; ai < doc.artboards.length; ai++) {
            var r = doc.artboards[ai].artboardRect; // [L,T,R,B]
            var w = ptToMm(r[2] - r[0]), h = ptToMm(r[1] - r[3]);
            rec.artboards.push({ name: String(doc.artboards[ai].name), w_mm: w, h_mm: h });
            if (w > maxAbW) maxAbW = w;
            if (h > maxAbH) maxAbH = h;
        }

        // --- Группировка обводок ---
        var groups = {}, order = [];
        function addStroke(p, ctx) {
            var info;
            try { info = strokeKeyLabel(p.strokeColor); } catch (e) { info = null; }
            if (!info) return;
            if (!groups[info.key]) {
                groups[info.key] = {
                    key: info.key, label: info.label, kind: info.kind,
                    countSeen: 0, countMissed: 0, closed: 0, open: 0,
                    sampleBboxMm: null, sampleStrokeWidthPt: null
                };
                order.push(info.key);
            }
            var g = groups[info.key];
            if (ctx.sees) g.countSeen++; else g.countMissed++;
            try { if (p.closed) g.closed++; else g.open++; } catch (e) {}
            if (g.sampleStrokeWidthPt == null) {
                try { g.sampleStrokeWidthPt = Math.round(p.strokeWidth * 100) / 100; } catch (e) {}
            }
            if (g.sampleBboxMm == null) {
                try {
                    var b = p.geometricBounds;
                    g.sampleBboxMm = { w: ptToMm(b[2] - b[0]), h: ptToMm(b[1] - b[3]) };
                } catch (e) {}
            }
        }

        // Рекурсивный обход контейнера.
        // ctx.sees   — увидит ли экспортёр эту обводку (top-level visible+unlocked,
        //              и НЕ внутри подслоя);
        // ctx.inSub  — путь внутри подслоя (блайндспот экспортёра).
        function scanContainer(c, ctx) {
            try {
                for (var i = 0; i < c.pathItems.length; i++) {
                    var p = c.pathItems[i];
                    try { if (p.stroked) addStroke(p, ctx); } catch (e) {}
                }
            } catch (e) {}
            try {
                for (var cc = 0; cc < c.compoundPathItems.length; cc++) {
                    var cp = c.compoundPathItems[cc];
                    for (var k = 0; k < cp.pathItems.length; k++) {
                        try { if (cp.pathItems[k].stroked) addStroke(cp.pathItems[k], ctx); }
                        catch (e) {}
                    }
                }
            } catch (e) {}
            try {
                for (var g = 0; g < c.groupItems.length; g++)
                    scanContainer(c.groupItems[g], ctx);
            } catch (e) {}
            // Подслои — экспортёр их НЕ обходит, помечаем sees=false, inSub=true
            try {
                for (var sl = 0; sl < c.layers.length; sl++) {
                    scanContainer(c.layers[sl], { sees: false, inSub: true });
                }
            } catch (e) {}
        }

        // Точный подсчёт strokes в подслоях (для предупреждения)
        function countSublayerStrokes(container) {
            var n = 0;
            try {
                for (var i = 0; i < container.pathItems.length; i++)
                    try { if (container.pathItems[i].stroked) n++; } catch (e) {}
            } catch (e) {}
            try {
                for (var cc = 0; cc < container.compoundPathItems.length; cc++) {
                    var cp = container.compoundPathItems[cc];
                    for (var k = 0; k < cp.pathItems.length; k++)
                        try { if (cp.pathItems[k].stroked) n++; } catch (e) {}
                }
            } catch (e) {}
            try {
                for (var g = 0; g < container.groupItems.length; g++)
                    n += countSublayerStrokes(container.groupItems[g]);
            } catch (e) {}
            try {
                for (var sl = 0; sl < container.layers.length; sl++)
                    n += countSublayerStrokes(container.layers[sl]);
            } catch (e) {}
            return n;
        }

        // --- Обход слоёв верхнего уровня ---
        var hasSublayers = false;
        for (var li = 0; li < doc.layers.length; li++) {
            var lay = doc.layers[li];
            var exportable = lay.visible && !lay.locked;
            var subCount = 0;
            try { subCount = lay.layers.length; } catch (e) {}
            if (subCount > 0) hasSublayers = true;

            rec.layersTop.push({
                name: String(lay.name),
                hidden: !lay.visible,
                locked: lay.locked,
                paths: lay.pathItems.length,
                compound: lay.compoundPathItems.length,
                groups: lay.groupItems.length,
                sublayers: subCount,
                text: lay.textFrames.length,
                placed: lay.placedItems.length,
                raster: lay.rasterItems.length
            });

            rec.imagesCount += lay.placedItems.length + lay.rasterItems.length;

            // Обводки прямо в слое и его группах видит экспортёр, если слой exportable
            scanContainer(lay, { sees: exportable, inSub: false });

            // Подслои этого слоя — отдельный точный счётчик
            try {
                for (var s = 0; s < lay.layers.length; s++)
                    rec.strokesInSublayers += countSublayerStrokes(lay.layers[s]);
            } catch (e) {}

            // Фон во весь лист: верхнеуровневые объекты слоя с bbox ≈ artboard
            if (maxAbW > 0 && maxAbH > 0) {
                try {
                    for (var pi2 = 0; pi2 < lay.pageItems.length; pi2++) {
                        var it = lay.pageItems[pi2];
                        try {
                            var ib = it.geometricBounds;
                            var iw = ptToMm(ib[2] - ib[0]), ih = ptToMm(ib[1] - ib[3]);
                            if (iw >= FULLSHEET_RATIO * maxAbW &&
                                ih >= FULLSHEET_RATIO * maxAbH) {
                                rec.suspectedFullSheet.push({
                                    layer: String(lay.name),
                                    type: String(it.typename),
                                    w_mm: iw, h_mm: ih
                                });
                            }
                        } catch (e) {}
                    }
                } catch (e) {}
            }
        }

        // --- Группы → массив, сортировка по countSeen ---
        for (var oi = 0; oi < order.length; oi++) rec.strokeGroups.push(groups[order[oi]]);
        rec.strokeGroups.sort(function (a, b) { return b.countSeen - a.countSeen; });

        // --- Кандидат cut-цвета: spot в приоритете, иначе самый массовый ---
        var candidate = null;
        for (var gi = 0; gi < rec.strokeGroups.length; gi++) {
            var grp = rec.strokeGroups[gi];
            if (grp.kind === "spot" && grp.countSeen > 0) {
                if (!candidate || grp.countSeen > candidate.countSeen) candidate = grp;
            }
        }
        if (!candidate) {
            for (var gj = 0; gj < rec.strokeGroups.length; gj++) {
                if (rec.strokeGroups[gj].countSeen > 0) { candidate = rec.strokeGroups[gj]; break; }
            }
        }
        if (candidate) {
            rec.candidateCut = {
                key: candidate.key, label: candidate.label, kind: candidate.kind,
                count: candidate.countSeen, missed: candidate.countMissed,
                closed: candidate.closed, open: candidate.open
            };
        }

        // ================= Чек-лист и вердикт =================
        function check(level, code, message) { rec.checks.push({ level: level, code: code, message: message }); }
        function worse(a, b) { // вернуть более тяжёлый вердикт
            var rank = { PASS: 0, WARN: 1, FAIL: 2 };
            return rank[b] > rank[a] ? b : a;
        }

        // 1) Есть ли вообще видимые обводки
        var totalSeen = 0;
        for (var ti = 0; ti < rec.strokeGroups.length; ti++) totalSeen += rec.strokeGroups[ti].countSeen;
        if (totalSeen === 0) {
            check("FAIL", "no_visible_strokes",
                  "Нет обводок на видимых незаблокированных слоях верхнего уровня — экспортёр найдёт 0 контуров.");
        }

        // 2) Кандидат реза
        if (!rec.candidateCut) {
            check("FAIL", "no_cut_candidate", "Не удалось определить группу-кандидат контура реза.");
        } else {
            check("PASS", "cut_candidate",
                  "Кандидат реза: " + rec.candidateCut.label + " — " +
                  rec.candidateCut.count + " контуров" +
                  (rec.candidateCut.kind === "spot" ? " (spot — хорошо)" : ""));

            // 3) Открытые контуры
            if (rec.candidateCut.open > 0) {
                check("WARN", "open_cut_paths",
                      rec.candidateCut.open + " контуров реза НЕ замкнуты — clipping mask может сработать криво.");
            }

            // 4) Часть резов на скрытых/заблокированных слоях
            if (rec.candidateCut.missed > 0) {
                check("WARN", "cut_on_hidden_locked",
                      rec.candidateCut.missed + " путей того же цвета лежат на скрытых/заблокированных слоях или в подслоях — экспортёр их не возьмёт.");
            }

            // 5) Мягкая сверка с числом в имени
            if (rec.filenameNumber != null) {
                if (rec.filenameNumber === rec.candidateCut.count) {
                    check("PASS", "count_matches_filename",
                          "Число контуров (" + rec.candidateCut.count + ") совпало с числом в имени файла.");
                } else {
                    check("WARN", "count_vs_filename",
                          "Контуров найдено " + rec.candidateCut.count + ", а в имени файла число " +
                          rec.filenameNumber + ". Если это кол-во стикеров — проверь раскладку/цвет реза.");
                }
            }
        }

        // 6) Неоднозначность cut-цвета (несколько сопоставимых групп)
        if (rec.candidateCut) {
            var comparable = 0;
            for (var ci = 0; ci < rec.strokeGroups.length; ci++) {
                var sg = rec.strokeGroups[ci];
                if (sg.countSeen >= Math.max(2, rec.candidateCut.count * 0.3)) comparable++;
            }
            if (comparable > 1) {
                check("WARN", "ambiguous_cut_color",
                      "Несколько сопоставимых групп обводок — возможен «развал» одного реза на разные значения цвета. Сверь группы вручную.");
            }
        }

        // 7) Блайндспот: обводки в подслоях
        if (rec.strokesInSublayers > 0) {
            check("WARN", "strokes_in_sublayers",
                  rec.strokesInSublayers + " обводок лежат в ПОДслоях. StickerExporter не обходит подслои — если рез там, экспортёр его не увидит. Разнеси на верхний уровень или дай знать — допишу обход подслоёв.");
        }

        // 8) Фон во весь лист
        if (rec.suspectedFullSheet.length > 0) {
            check("WARN", "fullsheet_background",
                  rec.suspectedFullSheet.length + " объект(ов) размером почти во весь лист — могут попасть фоном под каждый стикер. Вынеси их на отдельный слой и добавь в «Исключить слои».");
        }

        // 9) Есть ли картинки
        if (rec.imagesCount === 0) {
            check("WARN", "no_images",
                  "Не найдено raster/placed картинок — проверь, что графика стикеров есть (возможно, она в виде векторных путей).");
        }

        // Итоговый вердикт
        for (var vi = 0; vi < rec.checks.length; vi++) rec.verdict = worse(rec.verdict, rec.checks[vi].level);
        return rec;
    }

    // ================= Пакетный прогон =================================
    var prevUIL = app.userInteractionLevel;
    app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;

    var report = { generated_at: nowISO(), folder: inFolder.fsName,
                   files_total: aiFiles.length, results: [], errors: [] };

    var win = new Window("palette", "Preflight макетов", undefined, { closeButton: false });
    win.preferredSize.width = 420;
    win.add("statictext", undefined, "Файлов: " + aiFiles.length);
    var bar = win.add("progressbar", undefined, 0, aiFiles.length);
    bar.preferredSize.width = 380;
    var status = win.add("statictext", undefined, "");
    status.preferredSize.width = 380;
    win.show();

    for (var fi = 0; fi < aiFiles.length; fi++) {
        status.text = (fi + 1) + " / " + aiFiles.length + ": " + aiFiles[fi].name;
        bar.value = fi; win.update();
        var d = null;
        try {
            d = app.open(aiFiles[fi]);
            var rec = analyzeDoc(d);
            report.results.push(rec);
        } catch (e) {
            report.errors.push({ file: aiFiles[fi].name, error: String(e) });
        } finally {
            if (d) { try { d.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {} }
        }
    }
    bar.value = aiFiles.length; win.close();
    app.userInteractionLevel = prevUIL;

    // ---------- Человекочитаемая сводка --------------------------------
    var txt = [];
    function T(s) { txt.push(s == null ? "" : String(s)); }
    T("=== PREFLIGHT МАКЕТОВ ===");
    T("Папка: " + report.folder);
    T("Сгенерировано: " + report.generated_at);
    T("Файлов: " + report.files_total);
    T("");
    var counts = { PASS: 0, WARN: 0, FAIL: 0 };
    for (var ri = 0; ri < report.results.length; ri++) {
        var r = report.results[ri];
        counts[r.verdict] = (counts[r.verdict] || 0) + 1;
        T("──────────────────────────────────────────────");
        T("[" + r.verdict + "] " + r.file + "   (" + r.colorSpace +
          ", artboards: " + r.artboards.length + ")");
        if (r.candidateCut) {
            T("  Кандидат реза: " + r.candidateCut.label + " — " + r.candidateCut.count +
              " контуров (замкнутых " + r.candidateCut.closed + ", открытых " + r.candidateCut.open + ")");
        }
        if (r.filenameNumber != null) T("  Число в имени: " + r.filenameNumber);
        T("  Картинок (raster+placed): " + r.imagesCount);
        if (r.strokesInSublayers > 0) T("  Обводок в подслоях: " + r.strokesInSublayers);
        for (var ci2 = 0; ci2 < r.checks.length; ci2++) {
            if (r.checks[ci2].level === "PASS") continue;
            T("    " + r.checks[ci2].level + ": " + r.checks[ci2].message);
        }
        // Все stroke-группы (чтобы выбрать cut-цвет вручную, если надо)
        T("    Группы обводок:");
        for (var gi2 = 0; gi2 < r.strokeGroups.length; gi2++) {
            var g = r.strokeGroups[gi2];
            T("      [" + g.countSeen + (g.countMissed ? "+" + g.countMissed + " скрыто" : "") + "] " +
              g.label +
              (g.sampleStrokeWidthPt != null ? "  sw=" + g.sampleStrokeWidthPt + "pt" : "") +
              (g.sampleBboxMm ? "  bbox≈" + g.sampleBboxMm.w + "x" + g.sampleBboxMm.h + "мм" : ""));
        }
    }
    if (report.errors.length) {
        T("");
        T("=== ОШИБКИ ОТКРЫТИЯ ===");
        for (var ei = 0; ei < report.errors.length; ei++)
            T("  " + report.errors[ei].file + ": " + report.errors[ei].error);
    }
    T("");
    T("ИТОГО: PASS=" + (counts.PASS || 0) + "  WARN=" + (counts.WARN || 0) +
      "  FAIL=" + (counts.FAIL || 0));

    // ---------- Запись отчётов -----------------------------------------
    function writeFile(path, content) {
        var f = new File(path);
        f.encoding = "UTF-8";
        if (f.open("w")) { f.write(content); f.close(); return true; }
        return false;
    }
    var jsonPath = inFolder.fsName + "/preflight.json";
    var txtPath  = inFolder.fsName + "/preflight.txt";
    var okJson = false, okTxt = false;
    try { okJson = writeFile(jsonPath, toJSON(report, "  ", 0)); } catch (e) {}
    try { okTxt  = writeFile(txtPath, txt.join("\n")); } catch (e) {}

    var msg = "Preflight готов.\n\nФайлов: " + report.files_total +
              "\nPASS=" + (counts.PASS || 0) + "  WARN=" + (counts.WARN || 0) +
              "  FAIL=" + (counts.FAIL || 0);
    if (okJson) msg += "\n\nJSON: " + jsonPath + "\n(перешли его в чат с Claude)";
    if (okTxt)  msg += "\nTXT:  " + txtPath;
    if (!okJson && !okTxt) msg += "\n\nНе удалось записать отчёт в папку — проверь права.";
    alert(msg);

})();
