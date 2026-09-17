import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { Plantio, Lote, Gasto, Colheita } from "../db/types";

function formatCurrency(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDate(): string {
  return new Date().toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function generatePdfReport(
  plantios: Plantio[],
  lotes: Lote[],
  gastos: Gasto[],
  colheitas: Colheita[]
) {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;

  const custoDe = (pid: string) =>
    gastos
      .filter((g) => g.plantio_id === pid)
      .reduce((s, g) => s + (g.quantidade || 0) * (g.valor_unitario || 0), 0);

  const receitaDe = (pid: string) =>
    colheitas
      .filter((c) => c.plantio_id === pid)
      .reduce((s, c) => s + (c.quantidade || 0) * (c.preco_venda || 0), 0);

  const custoTotal = gastos.reduce(
    (s, g) => s + (g.quantidade || 0) * (g.valor_unitario || 0),
    0
  );
  const receitaTotal = colheitas.reduce(
    (s, c) => s + (c.quantidade || 0) * (c.preco_venda || 0),
    0
  );
  const lucro = receitaTotal - custoTotal;
  const margem = receitaTotal > 0 ? ((lucro / receitaTotal) * 100).toFixed(1) : "0";

  // --- Header ---
  doc.setFillColor(22, 163, 74); // #16a34a
  doc.rect(0, 0, pageWidth, 32, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text("Agrolote - Relatório", margin, 16);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(`Gerado em ${formatDate()}`, margin, 24);

  let y = 40;

  // --- Summary Section ---
  doc.setTextColor(30, 30, 30);
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("Resumo Geral", margin, y);
  y += 8;

  const summaryData = [
    ["Custo Total", formatCurrency(custoTotal)],
    ["Receita Total", formatCurrency(receitaTotal)],
    ["Lucro", formatCurrency(lucro)],
    ["Margem", `${margem}%`],
  ];

  autoTable(doc, {
    startY: y,
    head: [["Indicador", "Valor"]],
    body: summaryData,
    margin: { left: margin, right: margin },
    theme: "grid",
    headStyles: {
      fillColor: [22, 163, 74],
      textColor: [255, 255, 255],
      fontStyle: "bold",
    },
    styles: {
      fontSize: 10,
      cellPadding: 4,
    },
    columnStyles: {
      0: { fontStyle: "bold", cellWidth: 60 },
      1: { halign: "right" },
    },
  });

  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 12;

  // --- Resultado por Cultura ---
  const perCultura: Record<
    string,
    { custo: number; receita: number; rendimento: number; qtd: number }
  > = {};
  for (const p of plantios) {
    const row = (perCultura[p.cultura] ??= {
      custo: 0,
      receita: 0,
      rendimento: 0,
      qtd: 0,
    });
    row.custo += custoDe(p.id);
    row.receita += receitaDe(p.id);
    row.qtd += 1;
    row.rendimento += colheitas
      .filter((c) => c.plantio_id === p.id)
      .reduce((s, c) => s + (c.quantidade || 0), 0);
  }

  const culturaRows = Object.entries(perCultura)
    .map(([cultura, v]) => ({
      cultura,
      qtd: v.qtd,
      rendimento: v.rendimento,
      custo: v.custo,
      receita: v.receita,
      lucro: v.receita - v.custo,
      margem:
        v.receita > 0
          ? (((v.receita - v.custo) / v.receita) * 100).toFixed(1)
          : "0",
    }))
    .sort((a, b) => b.receita - a.receita);

  if (culturaRows.length > 0) {
    doc.setFontSize(13);
    doc.setFont("helvetica", "bold");
    doc.text("Resultado por Cultura", margin, y);
    y += 4;

    autoTable(doc, {
      startY: y,
      head: [
        [
          "Cultura",
          "Plantios",
          "Rendimento",
          "Custo",
          "Receita",
          "Lucro",
          "Margem",
        ],
      ],
      body: culturaRows.map((r) => [
        r.cultura,
        String(r.qtd),
        String(r.rendimento.toLocaleString("pt-BR")),
        formatCurrency(r.custo),
        formatCurrency(r.receita),
        formatCurrency(r.lucro),
        `${r.margem}%`,
      ]),
      margin: { left: margin, right: margin },
      theme: "grid",
      headStyles: {
        fillColor: [22, 163, 74],
        textColor: [255, 255, 255],
        fontStyle: "bold",
      },
      styles: { fontSize: 9, cellPadding: 3 },
      columnStyles: {
        0: { cellWidth: 32 },
        1: { halign: "center", cellWidth: 18 },
        2: { halign: "right", cellWidth: 24 },
        3: { halign: "right", cellWidth: 28 },
        4: { halign: "right", cellWidth: 28 },
        5: { halign: "right", cellWidth: 28 },
        6: { halign: "right", cellWidth: 18 },
      },
    });

    y =
      (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 12;
  }

  // --- Resultado por Lote ---
  const perLote = lotes
    .map((l) => {
      const pids = plantios
        .filter((p) => p.lote_id === l.id)
        .map((p) => p.id);
      const custo = pids.reduce((s, pid) => s + custoDe(pid), 0);
      const receita = pids.reduce((s, pid) => s + receitaDe(pid), 0);
      return { lote: l.nome, custo, receita, lucro: receita - custo };
    })
    .sort((a, b) => b.lucro - a.lucro);

  if (perLote.length > 0) {
    // Check if we need a new page
    if (y > doc.internal.pageSize.getHeight() - 60) {
      doc.addPage();
      y = 20;
    }

    doc.setFontSize(13);
    doc.setFont("helvetica", "bold");
    doc.text("Resultado por Lote", margin, y);
    y += 4;

    autoTable(doc, {
      startY: y,
      head: [["Lote", "Custo", "Receita", "Lucro"]],
      body: perLote.map((l) => [
        l.lote,
        formatCurrency(l.custo),
        formatCurrency(l.receita),
        formatCurrency(l.lucro),
      ]),
      margin: { left: margin, right: margin },
      theme: "grid",
      headStyles: {
        fillColor: [22, 163, 74],
        textColor: [255, 255, 255],
        fontStyle: "bold",
      },
      styles: { fontSize: 10, cellPadding: 4 },
      columnStyles: {
        0: { cellWidth: 50 },
        1: { halign: "right", cellWidth: 40 },
        2: { halign: "right", cellWidth: 40 },
        3: { halign: "right", cellWidth: 40 },
      },
    });
  }

  // --- Footer with page numbers ---
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    const pageH = doc.internal.pageSize.getHeight();
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.setFont("helvetica", "normal");
    doc.text(
      `Agrolote • Página ${i} de ${totalPages}`,
      pageWidth / 2,
      pageH - 10,
      { align: "center" }
    );
  }

  const filename = `relatorio-agrolote-${new Date().toISOString().slice(0, 10)}.pdf`;
  doc.save(filename);
}
