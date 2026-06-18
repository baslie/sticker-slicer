/*
================================================================================
  CloseOpenCutPaths.jsx — закрыть открытые контуры реза
================================================================================

  Зачем: если контур реза не замкнут (осталась микрощель), экспортёр обрежет
  стикер по нему с рваным краем. Этот скрипт находит открытые пути нужного
  cut-цвета и замыкает их (эквивалент Ctrl+J «Join» для каждого).

  Что делает (по активному документу):
  - Собирает все обводки видимых незаблокированных слоёв, группирует по цвету
    (как StickerExporter).
  - Показывает диалог: какой цвет — контур реза (по умолчанию самый массовый).
  - Замыкает ВСЕ открытые пути этого цвета (path.closed = true).
  - Сохраняет КОПИЮ <имя>__closed.ai рядом. Оригинал не трогается.

  Запуск: открыть .ai → File → Scripts → Other Script… → этот файл.
================================================================================
*/

#target illustrator

(function () {

    if (app.documents.length === 0) {
        alert("Открой .ai и запусти скрипт снова.");
        return;
    }
    var doc = app.activeDocument;

    // ---------- Сбор обводок + группировка по цвету ---------------------
    function collectAllStroked(parent, out) {
        for (var i = 0; i < parent.pathItems.length; i++) {
            try { if (parent.pathItems[i].stroked) out.push(parent.pathItems[i]); } catch (e) {}
        }
        for (var c = 0; c < parent.compoundPathItems.length; c++) {
            var cp = parent.compoundPathItems[c];
            for (var k = 0; k < cp.pathItems.length; k++) {
                try { if (cp.pathItems[k].stroked) out.push(cp.pathItems[k]); } catch (e) {}
            }
        }
        for (var g = 0; g < parent.groupItems.length; g++) {
            collectAllStroked(parent.groupItems[g], out);
        }
        return out;
    }

    function strokeKey(sc) {
        if (!sc) return null;
        try {
            if (sc.typename === "SpotColor" && sc.spot)
                return { key: "spot::" + sc.spot.name, label: 'Spot: "' + sc.spot.name + '"' };
            if (sc.typename === "CMYKColor") {
                var c = Math.round(sc.cyan), m = Math.round(sc.magenta),
                    y = Math.round(sc.yellow), k = Math.round(sc.black);
                return { key: "cmyk::" + c + "," + m + "," + y + "," + k,
                         label: "CMYK(" + c + "," + m + "," + y + "," + k + ")" };
            }
            if (sc.typename === "RGBColor") {
                var r = Math.round(sc.red), g = Math.round(sc.green), b = Math.round(sc.blue);
                return { key: "rgb::" + r + "," + g + "," + b,
                         label: "RGB(" + r + "," + g + "," + b + ")" };
            }
            return { key: "other::" + sc.typename, label: sc.typename };
        } catch (e) { return null; }
    }

    var all = [];
    for (var li = 0; li < doc.layers.length; li++) {
        if (!doc.layers[li].visible || doc.layers[li].locked) continue;
        collectAllStroked(doc.layers[li], all);
    }
    if (all.length === 0) { alert("Не нашёл обводок на видимых незаблокированных слоях."); return; }

    // Группируем: всего путей + сколько из них открытых
    var groups = {}, order = [];
    for (var i = 0; i < all.length; i++) {
        var info = strokeKey(all[i].strokeColor);
        if (!info) continue;
        if (!groups[info.key]) {
            groups[info.key] = { label: info.label, total: 0, open: 0 };
            order.push(info.key);
        }
        groups[info.key].total++;
        try { if (!all[i].closed) groups[info.key].open++; } catch (e) {}
    }
    order.sort(function (a, b) { return groups[b].total - groups[a].total; });

    // ---------- Диалог выбора цвета реза --------------------------------
    var dlg = new Window("dialog", "Закрыть открытые контуры реза");
    dlg.orientation = "column"; dlg.alignChildren = "fill"; dlg.preferredSize.width = 420;
    dlg.add("statictext", undefined, "Какой цвет — контур реза? Закроем его открытые пути:",
            { multiline: true });
    var radios = [];
    for (var oi = 0; oi < order.length; oi++) {
        var g = groups[order[oi]];
        var rb = dlg.add("radiobutton", undefined,
            g.label + "  —  всего " + g.total + ", открытых " + g.open);
        rb._key = order[oi];
        if (oi === 0) rb.value = true;
        radios.push(rb);
    }
    var btns = dlg.add("group"); btns.alignment = "right";
    btns.add("button", undefined, "Отмена", { name: "cancel" });
    btns.add("button", undefined, "Закрыть контуры", { name: "ok" });
    if (dlg.show() !== 1) return;

    var chosen = null;
    for (var r = 0; r < radios.length; r++) if (radios[r].value) { chosen = radios[r]._key; break; }
    if (!chosen) return;

    if (groups[chosen].open === 0) {
        alert("У выбранного цвета нет открытых контуров — всё уже замкнуто.\n" +
              "Ничего менять не нужно.");
        return;
    }

    // ---------- Замыкаем открытые пути выбранного цвета -----------------
    var closed = 0, failed = 0;
    for (var p = 0; p < all.length; p++) {
        var path = all[p];
        var info2 = strokeKey(path.strokeColor);
        if (!info2 || info2.key !== chosen) continue;
        try {
            if (!path.closed) { path.closed = true; closed++; }
        } catch (e) { failed++; }
    }

    // ---------- Сохранить копию -----------------------------------------
    var savedPath = null;
    try {
        var base = doc.name.replace(/\.ai$/i, "");
        var newFile = new File(doc.fullName.parent.fsName + "/" + base + "__closed.ai");
        var opts = new IllustratorSaveOptions();
        opts.pdfCompatible = true;
        doc.saveAs(newFile, opts);
        savedPath = newFile.fsName;
    } catch (eSave) {
        alert("Замкнуто контуров: " + closed +
              "\nНо сохранить копию не удалось:\n" + eSave +
              "\n\nСохрани файл вручную как <имя>__closed.ai.");
        return;
    }

    alert("Готово.\n\nЗамкнуто открытых контуров: " + closed +
          (failed ? "\nНе удалось: " + failed : "") +
          "\n\nКопия сохранена:\n" + savedPath +
          "\n\nЭкспортируй стикеры уже из этого файла.");

})();
