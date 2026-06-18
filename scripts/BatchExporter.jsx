/*
================================================================================
  BatchExporter.jsx — пакетный экспорт стикеров из папки .ai-макетов
================================================================================

  За один запуск:
    1. Просит папку с макетами.
    2. Проверяет, что в ней ТОЛЬКО .ai-файлы (никаких подпапок и посторонних
       файлов) — иначе ругается и просит исправить папку.
    3. Просит параметры экспорта (один раз на весь прогон).
    4. Просит выходную папку.
    5. Поочерёдно открывает каждый .ai, САМ определяет цвет контура реза
       (spot в приоритете, иначе самая массовая обводка) и выгружает стикеры в
       ПОДПАПКУ с именем файла внутри выходной папки. Закрывает без сохранения.
    6. Пишет сводный отчёт batch_report.txt / batch_report.json.

  Работает и когда в папке один файл (N=1).
  Файлы должны быть готовы к экспорту: проблемные (KOTYKI с невидимым резом —
  через FixClipCut, открытые контуры — через CloseOpenCutPaths) клади уже
  почивленными копиями (__cut.ai / __closed.ai). Файлы без найденного реза
  пакетник пропускает и пишет в отчёт.

  Движок экспорта — общий, в StickerCore.jsx (подключается рядом).
  Запуск: File → Scripts → Other Script… → BatchExporter.jsx
================================================================================
*/

#target illustrator

(function () {

    // ---------- Подключаем общий движок ---------------------------------
    if (typeof SC_exportDoc !== "function") {
        try {
            $.evalFile(new File(new File($.fileName).parent.fsName + "/StickerCore.jsx"));
        } catch (eInc) {
            alert("Не найден StickerCore.jsx рядом со скриптом.\n" + eInc);
            return;
        }
    }

    var SETTINGS = {
        whiteOutlineMm:     2.5,
        paddingMm:          1.0,
        exportScalePercent: 200,
        fileNamePrefix:     "sticker_",
        sizesFileName:      "sizes.json"
    };

    // ---------- 1. Папка с макетами -------------------------------------
    var inFolder = Folder.selectDialog("Папка с .ai-макетами (только .ai, без подпапок)");
    if (!inFolder) return;

    // ---------- 2. Валидация папки --------------------------------------
    var ignoreNames = { "Thumbs.db": 1, ".DS_Store": 1, "desktop.ini": 1 };
    var entries = inFolder.getFiles();
    var aiFiles = [], offenders = [];
    for (var e = 0; e < entries.length; e++) {
        var it = entries[e];
        if (it instanceof Folder) { offenders.push(it.name + "  (подпапка)"); continue; }
        if (/\.ai$/i.test(it.name)) { aiFiles.push(it); continue; }
        if (ignoreNames[it.name]) continue; // системный мусор — игнор
        offenders.push(it.name);
    }
    if (offenders.length > 0) {
        var ol = offenders.slice(0, 15).join("\n");
        if (offenders.length > 15) ol += "\n…ещё " + (offenders.length - 15);
        alert("В папке есть посторонние элементы:\n\n" + ol +
              "\n\nОставь в папке ТОЛЬКО .ai-файлы (без подпапок и других файлов)\n" +
              "и запусти скрипт снова.");
        return;
    }
    if (aiFiles.length === 0) {
        alert("В папке нет .ai-файлов:\n" + inFolder.fsName);
        return;
    }
    aiFiles.sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });

    // ---------- 3. Параметры экспорта (один раз) ------------------------
    var dlg = new Window("dialog", "Пакетный экспорт стикеров");
    dlg.orientation = "column"; dlg.alignChildren = "fill"; dlg.preferredSize.width = 460;
    dlg.add("statictext", undefined, "Файлов к обработке: " + aiFiles.length +
            ".  Цвет реза определяется автоматически для каждого файла.", { multiline: true });

    var pnl = dlg.add("panel", undefined, "Параметры экспорта");
    pnl.orientation = "column"; pnl.alignChildren = "left"; pnl.margins = 12;
    function num(parent, label, def, suffix) {
        var r = parent.add("group");
        var l = r.add("statictext", undefined, label); l.preferredSize.width = 220;
        var ed = r.add("edittext", undefined, String(def)); ed.preferredSize.width = 70;
        if (suffix) r.add("statictext", undefined, suffix);
        return ed;
    }
    var edWhite = num(pnl, "Толщина белой подложки:", SETTINGS.whiteOutlineMm, "мм");
    var edPad   = num(pnl, "Запас на artboard:",      SETTINGS.paddingMm, "мм");
    var edScale = num(pnl, "Масштаб PNG:",            SETTINGS.exportScalePercent, "%");
    var grpExcl = pnl.add("group");
    var lblExcl = grpExcl.add("statictext", undefined, "Исключить слои (через запятую):");
    lblExcl.preferredSize.width = 220;
    var edExclude = grpExcl.add("edittext", undefined, "MARKS CUT");
    edExclude.preferredSize.width = 160;

    var btnRow = dlg.add("group"); btnRow.alignment = "right";
    btnRow.add("button", undefined, "Отмена", { name: "cancel" });
    btnRow.add("button", undefined, "Дальше — выбрать папку вывода", { name: "ok" });
    if (dlg.show() !== 1) return;

    SETTINGS.whiteOutlineMm     = parseFloat(edWhite.text) || SETTINGS.whiteOutlineMm;
    SETTINGS.paddingMm          = parseFloat(edPad.text)   || SETTINGS.paddingMm;
    SETTINGS.exportScalePercent = parseFloat(edScale.text) || SETTINGS.exportScalePercent;

    var excludeSet = {};
    var exclParts = String(edExclude.text || "").split(",");
    for (var ex = 0; ex < exclParts.length; ex++) {
        var nm = exclParts[ex].replace(/^\s+|\s+$/g, "");
        if (nm.length > 0) excludeSet[nm] = true;
    }

    // ---------- 4. Выходная папка ---------------------------------------
    var outRoot = Folder.selectDialog("Выходная папка (тут создадутся подпапки по именам файлов)");
    if (!outRoot) return;
    if (outRoot.fsName === inFolder.fsName) {
        var cont = confirm("Выходная папка совпадает с входной.\n\n" +
                           "Подпапки со стикерами создадутся прямо среди .ai-файлов.\n" +
                           "Продолжить?");
        if (!cont) return;
    }

    // ---------- Прогресс-окно -------------------------------------------
    var win = new Window("palette", "Пакетный экспорт", undefined, { closeButton: false });
    win.preferredSize.width = 440;
    var fileStatus = win.add("statictext", undefined, "Файл 0 / " + aiFiles.length);
    fileStatus.preferredSize.width = 400;
    var stStatus = win.add("statictext", undefined, ""); stStatus.preferredSize.width = 400;
    var bar = win.add("progressbar", undefined, 0, 1); bar.preferredSize.width = 400;
    win.show();

    // ---------- Утилиты отчёта ------------------------------------------
    function nowISO() {
        function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }
        var d = new Date();
        return d.getFullYear() + "-" + pad(d.getMonth() + 1, 2) + "-" + pad(d.getDate(), 2) +
               "T" + pad(d.getHours(), 2) + ":" + pad(d.getMinutes(), 2) + ":" + pad(d.getSeconds(), 2);
    }

    var prevUIL = app.userInteractionLevel;
    app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;

    var results = [];
    var totalExported = 0, filesOk = 0, filesSkipped = 0, filesWithErrors = 0;

    // ---------- 5. Главный цикл по файлам -------------------------------
    for (var fi = 0; fi < aiFiles.length; fi++) {
        var file = aiFiles[fi];
        var base = file.name.replace(/\.ai$/i, "");
        fileStatus.text = "Файл " + (fi + 1) + " / " + aiFiles.length + ": " + file.name;
        stStatus.text = "Открываю…"; bar.value = 0; win.update();

        var rec = { file: file.name, cut_color: null, exported: 0, total: 0,
                    skipped: false, reason: null, errors: [] };
        var d = null;
        try {
            d = app.open(file);

            // Авто-определение цвета реза
            var sg = SC_collectStrokeGroups(d);
            var key = SC_pickCutCandidate(sg.groups, sg.keysOrder);
            if (!key) {
                rec.skipped = true; rec.reason = "не найден контур реза (нет обводок)";
                filesSkipped++;
                continue; // rec запишется и документ закроется в finally
            }
            var chosenGroup = sg.groups[key];
            rec.cut_color = chosenGroup.label;

            // Подпапка по имени файла (перезапись: чистим старые PNG)
            var subF = new Folder(outRoot.fsName + "/" + base);
            if (!subF.exists) subF.create();
            var oldPngs = subF.getFiles("*.png");
            for (var op = 0; op < oldPngs.length; op++) {
                try {
                    if (oldPngs[op] instanceof File &&
                        oldPngs[op].name.indexOf(SETTINGS.fileNamePrefix) === 0) {
                        oldPngs[op].remove();
                    }
                } catch (eRm) {}
            }

            // Прогресс по стикерам этого файла
            var fileLabel = file.name;
            var cb = (function (label) {
                return function (idx, total) {
                    bar.maxvalue = total; bar.value = idx;
                    stStatus.text = label + ": стикер " + idx + " / " + total;
                    win.update();
                };
            })(fileLabel);

            var res = SC_exportDoc(d, chosenGroup, SETTINGS, excludeSet, subF, cb);
            rec.exported = res.exported;
            rec.total = res.total;
            rec.errors = res.errors || [];
            totalExported += res.exported;
            if (rec.errors.length) filesWithErrors++;
            if (res.exported > 0) filesOk++;
            else if (!rec.skipped) { rec.skipped = true; rec.reason = "0 стикеров (" +
                     (rec.errors.length ? "ошибки" : "контуры не найдены") + ")"; filesSkipped++; }

        } catch (err) {
            rec.errors.push("открытие/экспорт: " + err);
            filesWithErrors++;
        } finally {
            if (d) { try { d.close(SaveOptions.DONOTSAVECHANGES); } catch (eCl) {} }
            results.push(rec);
        }
    }

    app.userInteractionLevel = prevUIL;
    win.close();

    // ---------- 6. Сводный отчёт ----------------------------------------
    var report = {
        generated_at: nowISO(),
        input_folder: inFolder.fsName,
        output_folder: outRoot.fsName,
        settings: {
            white_outline_mm:     SETTINGS.whiteOutlineMm,
            padding_mm:           SETTINGS.paddingMm,
            export_scale_percent: SETTINGS.exportScalePercent
        },
        totals: {
            files: aiFiles.length, files_ok: filesOk, files_skipped: filesSkipped,
            files_with_errors: filesWithErrors, stickers_total: totalExported
        },
        results: results
    };

    // JSON (свой сериализатор, как в ядре — ES3 без JSON.stringify)
    function toJSON(value, indent, level) {
        if (level === undefined) level = 0;
        var pad = ""; for (var pi = 0; pi < level; pi++) pad += indent; var pad2 = pad + indent;
        if (value === null || value === undefined) return "null";
        var t = typeof value;
        if (t === "number") return isFinite(value) ? String(value) : "null";
        if (t === "boolean") return value ? "true" : "false";
        if (t === "string") {
            var s = "\"";
            for (var ci = 0; ci < value.length; ci++) {
                var ch = value.charAt(ci), cc = value.charCodeAt(ci);
                if (ch === "\"") s += "\\\""; else if (ch === "\\") s += "\\\\";
                else if (ch === "\n") s += "\\n"; else if (ch === "\r") s += "\\r";
                else if (ch === "\t") s += "\\t";
                else if (cc < 0x20) { var hex = cc.toString(16); while (hex.length < 4) hex = "0" + hex; s += "\\u" + hex; }
                else s += ch;
            }
            return s + "\"";
        }
        if (value instanceof Array) {
            if (value.length === 0) return "[]";
            var arr = []; for (var ai = 0; ai < value.length; ai++) arr.push(pad2 + toJSON(value[ai], indent, level + 1));
            return "[\n" + arr.join(",\n") + "\n" + pad + "]";
        }
        if (t === "object") {
            var keys = []; for (var k in value) if (value.hasOwnProperty(k)) keys.push(k);
            if (keys.length === 0) return "{}";
            var parts = [];
            for (var ki = 0; ki < keys.length; ki++) parts.push(pad2 + toJSON(keys[ki], indent, level + 1) + ": " + toJSON(value[keys[ki]], indent, level + 1));
            return "{\n" + parts.join(",\n") + "\n" + pad + "}";
        }
        return "null";
    }

    function writeFile(path, content) {
        var f = new File(path); f.encoding = "UTF-8";
        if (f.open("w")) { f.write(content); f.close(); return true; }
        return false;
    }

    // Человекочитаемый отчёт
    var txt = [];
    txt.push("=== ПАКЕТНЫЙ ЭКСПОРТ ===");
    txt.push("Сгенерировано: " + report.generated_at);
    txt.push("Входная папка:  " + report.input_folder);
    txt.push("Выходная папка: " + report.output_folder);
    txt.push("");
    txt.push("ИТОГО: файлов " + report.totals.files + ", успешно " + report.totals.files_ok +
             ", пропущено " + report.totals.files_skipped + ", с ошибками " + report.totals.files_with_errors +
             ", стикеров всего " + report.totals.stickers_total);
    txt.push("");
    for (var ri = 0; ri < results.length; ri++) {
        var r = results[ri];
        var head = (r.skipped ? "[ПРОПУСК] " : "[OK]      ") + r.file;
        txt.push(head);
        if (r.cut_color) txt.push("    рез: " + r.cut_color);
        txt.push("    стикеров: " + r.exported + " / " + r.total);
        if (r.reason) txt.push("    причина: " + r.reason);
        for (var ei = 0; ei < r.errors.length && ei < 5; ei++) txt.push("    ошибка: " + r.errors[ei]);
        if (r.errors.length > 5) txt.push("    …ещё ошибок: " + (r.errors.length - 5));
    }

    var jsonPath = outRoot.fsName + "/batch_report.json";
    var txtPath  = outRoot.fsName + "/batch_report.txt";
    var okJson = false, okTxt = false;
    try { okJson = writeFile(jsonPath, toJSON(report, "  ", 0)); } catch (e1) {}
    try { okTxt  = writeFile(txtPath, txt.join("\n")); } catch (e2) {}

    var msg = "Пакетный экспорт завершён.\n\n" +
              "Файлов: " + report.totals.files +
              "\n  успешно: " + report.totals.files_ok +
              "\n  пропущено: " + report.totals.files_skipped +
              "\n  с ошибками: " + report.totals.files_with_errors +
              "\nСтикеров всего: " + report.totals.stickers_total +
              "\n\nВыход: " + outRoot.fsName;
    if (okTxt)  msg += "\nОтчёт: " + txtPath;
    if (!okJson && !okTxt) msg += "\n\n(не удалось записать отчёт — проверь права на папку)";
    alert(msg);

})();
