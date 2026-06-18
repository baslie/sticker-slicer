/*
================================================================================
  InspectCutGeometry.jsx — геометрия контуров реза + проверка перекрытий
================================================================================

  Зачем: понять, почему стикеры режутся неправильно (прямоугольником и/или
  с прихватом соседей). Анализирует пути выбранного cut-цвета:
  - форма: число опорных точек (прямоугольник ≈ 4-5, силуэт — десятки/сотни);
  - размеры bbox каждого контура;
  - ПЕРЕКРЫТИЯ: для каждого контура считает, сколько ДРУГИХ контуров реза
    залезают в его bbox (если рамки фото наложены друг на друга — сосед
    физически попадёт в кадр даже при правильной маске).
  - обрезанность (clipped) групп верхнего уровня и состав первых групп.

  Цвет реза по умолчанию: spot "CutContour" (его навешивает FixClipCut),
  иначе самая массовая stroke-группа.

  Отчёт: <имя>__cutgeom.txt рядом с .ai. Запуск: открыть .ai → File → Scripts.
================================================================================
*/

#target illustrator

(function () {

    if (app.documents.length === 0) { alert("Открой .ai и запусти снова."); return; }
    var doc = app.activeDocument;
    var MM2PT = 2.83464567;
    function ptToMm(pt) { return Math.round((pt / MM2PT) * 100) / 100; }
    function boxArea(b) { try { return Math.abs((b[2]-b[0])*(b[1]-b[3])); } catch(e){ return 0; } }

    var lines = [];
    function L(s) { lines.push(s == null ? "" : String(s)); }

    function strokeKey(sc) {
        if (!sc) return null;
        try {
            if (sc.typename === "SpotColor" && sc.spot) return "spot::" + sc.spot.name;
            if (sc.typename === "CMYKColor")
                return "cmyk::" + Math.round(sc.cyan)+","+Math.round(sc.magenta)+","+
                       Math.round(sc.yellow)+","+Math.round(sc.black);
            if (sc.typename === "RGBColor")
                return "rgb::" + Math.round(sc.red)+","+Math.round(sc.green)+","+Math.round(sc.blue);
            return "other::" + sc.typename;
        } catch (e) { return null; }
    }

    // ---------- Собрать все stroked-пути ---------------------------------
    var all = [];
    function collect(parent) {
        for (var i=0;i<parent.pathItems.length;i++)
            try { if (parent.pathItems[i].stroked) all.push(parent.pathItems[i]); } catch(e){}
        for (var c=0;c<parent.compoundPathItems.length;c++){
            var cp=parent.compoundPathItems[c];
            for (var k=0;k<cp.pathItems.length;k++)
                try { if (cp.pathItems[k].stroked) all.push(cp.pathItems[k]); } catch(e){}
        }
        for (var g=0;g<parent.groupItems.length;g++) collect(parent.groupItems[g]);
        try { for (var s=0;s<parent.layers.length;s++) collect(parent.layers[s]); } catch(e){}
    }
    for (var li=0; li<doc.layers.length; li++) collect(doc.layers[li]);

    // ---------- Выбрать cut-цвет ----------------------------------------
    var byKey = {}, order = [];
    for (var a=0;a<all.length;a++){
        var k = strokeKey(all[a].strokeColor);
        if (!k) continue;
        if (!byKey[k]) { byKey[k]=[]; order.push(k); }
        byKey[k].push(all[a]);
    }
    var chosenKey = null;
    for (var o=0;o<order.length;o++) if (order[o]==="spot::CutContour") { chosenKey=order[o]; break; }
    if (!chosenKey) {
        order.sort(function(x,y){ return byKey[y].length - byKey[x].length; });
        chosenKey = order[0];
    }
    var cuts = byKey[chosenKey] || [];

    L("=== INSPECT CUT GEOMETRY ===");
    L("Документ: " + doc.name);
    L("Cut-цвет: " + chosenKey + "  (контуров: " + cuts.length + ")");
    L("");

    // ---------- Форма: гистограмма числа точек --------------------------
    function pointCount(p) { try { return p.pathPoints.length; } catch(e){ return -1; } }
    var rectLike = 0, complex = 0;
    for (var i=0;i<cuts.length;i++){
        var pc = pointCount(cuts[i]);
        if (pc >= 0 && pc <= 6) rectLike++; else complex++;
    }
    L("=== ФОРМА КОНТУРОВ ===");
    L("Прямоугольных (≤6 точек): " + rectLike);
    L("Сложных силуэтов (>6 точек): " + complex);
    L("(если почти все прямоугольные — стикеры режутся рамкой фото, а не по силуэту)");
    L("");

    // ---------- Первые 12 контуров: точки + bbox ------------------------
    L("=== ПЕРВЫЕ 12 КОНТУРОВ ===");
    for (var j=0; j<cuts.length && j<12; j++){
        var b = cuts[j].geometricBounds;
        L("  #" + (j+1) + "  точек=" + pointCount(cuts[j]) +
          "  bbox " + ptToMm(b[2]-b[0]) + "x" + ptToMm(b[1]-b[3]) + "мм" +
          "  L=" + ptToMm(b[0]) + " T=" + ptToMm(b[1]));
    }
    L("");

    // ---------- Перекрытия bbox контуров --------------------------------
    // Берём bbox каждого контура, чуть ужимаем (на 5%), и считаем, сколько
    // ДРУГИХ контуров попадают своим bbox в него. >0 => рамки наложены.
    function inset(b, f){
        var dx=(b[2]-b[0])*f, dy=(b[1]-b[3])*f;
        return [b[0]+dx, b[1]-dy, b[2]-dx, b[3]+dy];
    }
    function intersect(a,b){ return !(a[2]<b[0]||a[0]>b[2]||a[3]>b[1]||a[1]<b[3]); }
    var bboxes = [];
    for (var q=0;q<cuts.length;q++){ try { bboxes.push(cuts[q].geometricBounds); } catch(e){ bboxes.push(null); } }
    var withOverlap = 0, totalOverlaps = 0, examples = [];
    for (var x=0;x<bboxes.length;x++){
        if (!bboxes[x]) continue;
        var core = inset(bboxes[x], 0.05);
        var cnt = 0;
        for (var y=0;y<bboxes.length;y++){
            if (x===y || !bboxes[y]) continue;
            if (intersect(core, bboxes[y])) cnt++;
        }
        if (cnt>0){
            withOverlap++; totalOverlaps += cnt;
            if (examples.length < 8){
                var bx = bboxes[x];
                examples.push("  #" + (x+1) + " (" + ptToMm(bx[2]-bx[0]) + "x" +
                              ptToMm(bx[1]-bx[3]) + "мм) перекрыт " + cnt + " соседями");
            }
        }
    }
    L("=== ПЕРЕКРЫТИЯ РАМОК РЕЗА ===");
    L("Контуров, в чей bbox залезает сосед: " + withOverlap + " из " + cuts.length);
    L("(если их много — соседние фото наложены, и сосед попадёт в кадр даже при правильной маске)");
    for (var e=0;e<examples.length;e++) L(examples[e]);
    L("");

    // ---------- Группы верхнего уровня: clipped + состав -----------------
    L("=== ПЕРВЫЕ ГРУППЫ (clipped + состав) ===");
    var shown=0;
    function memberDesc(it){
        var t=it.typename, ex="";
        try {
            if (t==="PathItem"){
                ex=(it.clipping?"CLIP ":"")+(it.closed?"closed":"open")+
                   " точек="+(it.pathPoints?it.pathPoints.length:"?")+
                   (it.filled?" fill":"")+(it.stroked?" stroke":"");
                var bb=it.geometricBounds;
                ex+=" "+ptToMm(bb[2]-bb[0])+"x"+ptToMm(bb[1]-bb[3])+"мм";
            }
        } catch(e){}
        return t+(ex?" ["+ex+"]":"");
    }
    for (var lg=0; lg<doc.layers.length && shown<6; lg++){
        var lay=doc.layers[lg];
        for (var gi=0; gi<lay.groupItems.length && shown<6; gi++){
            var grp=lay.groupItems[gi]; shown++;
            var cl=""; try { cl = grp.clipped ? "  CLIPPED" : ""; } catch(e){}
            var gb; try { gb=grp.geometricBounds; } catch(e){ gb=null; }
            L("  Группа #"+shown+cl+(gb?"  bbox "+ptToMm(gb[2]-gb[0])+"x"+ptToMm(gb[1]-gb[3])+"мм":"")+
              "  элементов "+grp.pageItems.length+":");
            try {
                for (var pi=0; pi<grp.pageItems.length && pi<10; pi++)
                    L("      - "+memberDesc(grp.pageItems[pi]));
            } catch(e){}
        }
    }
    L("");

    // ---------- Сохранить -----------------------------------------------
    var outPath;
    try { outPath = doc.fullName.parent.fsName + "/" + doc.name + "__cutgeom.txt"; }
    catch(e){ outPath = Folder.desktop.fsName + "/" + doc.name + "__cutgeom.txt"; }
    var f=new File(outPath); f.encoding="UTF-8";
    if (f.open("w")){ f.write(lines.join("\n")); f.close();
        alert("Отчёт сохранён:\n"+outPath+"\n\nПерешли его в чат."); }
    else alert("Не удалось записать:\n"+outPath);

})();
