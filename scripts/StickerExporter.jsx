/*
================================================================================
  StickerExporter.jsx (v5) — экспорт стикеров (интерактивный, один документ)
================================================================================

  Движок вынесен в StickerCore.jsx (подключается рядом). Этот файл — только UI:
  диалог выбора цвета реза + параметры + выходная папка. Логика экспорта одна
  и та же у интерактивного и пакетного (BatchExporter.jsx) режимов.

  Запуск: открыть .ai → File → Scripts → Other Script… → StickerExporter.jsx
================================================================================
*/

#target illustrator

(function () {

    // ---------- Подключаем общий движок StickerCore.jsx -----------------
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

    if (app.documents.length === 0) {
        alert("Откройте .ai файл и запустите скрипт снова.");
        return;
    }
    var doc = app.activeDocument;

    // ---------- Группировка обводок (через ядро) ------------------------
    var sg = SC_collectStrokeGroups(doc);
    var groups = sg.groups, keysOrder = sg.keysOrder;
    if (keysOrder.length === 0) {
        alert("Нет ни одной обводки в видимых незаблокированных слоях.\n" +
              "Проверь, что слой реза видимый и не заблокирован.");
        return;
    }

    // ---------- Диалог выбора + настройки -------------------------------
    var dlg = new Window("dialog", "Экспорт стикеров (v5)");
    dlg.orientation = "column"; dlg.alignChildren = "fill"; dlg.preferredSize.width = 460;
    dlg.add("statictext", undefined, "Выбери, какие линии — это контуры реза:", { multiline: true });

    keysOrder.sort(function (a, b) { return groups[b].count - groups[a].count; });
    var radios = [];
    for (var ki = 0; ki < keysOrder.length; ki++) {
        var k = keysOrder[ki], g = groups[k];
        var rbo = dlg.add("radiobutton", undefined, g.label + "  —  " + g.count + " путей");
        rbo._key = k;
        if (ki === 0) rbo.value = true;
        radios.push(rbo);
    }

    var pnl = dlg.add("panel", undefined, "Параметры экспорта");
    pnl.orientation = "column"; pnl.alignChildren = "left"; pnl.margins = 12;
    function num(parent, label, def, suffix) {
        var r = parent.add("group");
        var l = r.add("statictext", undefined, label); l.preferredSize.width = 220;
        var e = r.add("edittext", undefined, String(def)); e.preferredSize.width = 70;
        if (suffix) r.add("statictext", undefined, suffix);
        return e;
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
    btnRow.add("button", undefined, "Экспортировать", { name: "ok" });
    if (dlg.show() !== 1) return;

    var chosenKey = null;
    for (var r = 0; r < radios.length; r++) if (radios[r].value) { chosenKey = radios[r]._key; break; }
    if (!chosenKey) return;
    var chosenGroup = groups[chosenKey];

    SETTINGS.whiteOutlineMm     = parseFloat(edWhite.text) || SETTINGS.whiteOutlineMm;
    SETTINGS.paddingMm          = parseFloat(edPad.text)   || SETTINGS.paddingMm;
    SETTINGS.exportScalePercent = parseFloat(edScale.text) || SETTINGS.exportScalePercent;

    var excludeSet = {};
    var exclParts = String(edExclude.text || "").split(",");
    for (var ex = 0; ex < exclParts.length; ex++) {
        var nm = exclParts[ex].replace(/^\s+|\s+$/g, "");
        if (nm.length > 0) excludeSet[nm] = true;
    }

    var outFolder = Folder.selectDialog("Куда сохранить PNG?");
    if (!outFolder) return;

    // ---------- Прогресс-окно -------------------------------------------
    var win = new Window("palette", "Экспорт стикеров", undefined, { closeButton: false });
    win.preferredSize.width = 380;
    var status = win.add("statictext", undefined, "Подготовка…"); status.preferredSize.width = 340;
    var bar = win.add("progressbar", undefined, 0, 1); bar.preferredSize.width = 340;
    win.show();
    function progressCb(idx, total) {
        bar.maxvalue = total; bar.value = idx;
        status.text = "Стикер " + idx + " / " + total;
        win.update();
    }

    // ---------- Экспорт через ядро --------------------------------------
    var res = SC_exportDoc(doc, chosenGroup, SETTINGS, excludeSet, outFolder, progressCb);
    win.close();

    var msg = "Готово!\n\nЭкспортировано: " + res.exported + " / " + res.total +
              "\nПапка: " + outFolder.fsName;
    if (res.sizesWritten) msg += "\nРазмеры: " + res.sizesPath;
    if (res.errors && res.errors.length) {
        msg += "\n\nОшибок: " + res.errors.length + "\n" + res.errors.slice(0, 5).join("\n");
        if (res.errors.length > 5) msg += "\n…ещё " + (res.errors.length - 5);
    }
    alert(msg);

})();
