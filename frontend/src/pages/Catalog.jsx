import { useEffect, useRef, useState } from "react";
import api from "@/lib/api";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, FileCheck2, FileX2, Trash2, Upload } from "lucide-react";

export default function Catalog() {
  const [ranges, setRanges] = useState([]);
  const [newRange, setNewRange] = useState("");
  const uploadRef = useRef({});

  const load = async () => {
    const r = await api.get("/catalog");
    setRanges(r.data);
  };
  useEffect(() => { load(); }, []);

  const addRange = async () => {
    if (!newRange.trim()) return;
    await api.post("/catalog/range", { name: newRange.trim() });
    setNewRange("");
    load();
  };
  const delRange = async (id) => {
    if (!window.confirm("Delete this product range?")) return;
    await api.delete(`/catalog/range/${id}`);
    load();
  };

  const addBrand = async (rid) => {
    const name = window.prompt("Brand name?");
    if (!name) return;
    await api.post(`/catalog/range/${rid}/brand`, { name });
    load();
  };
  const delBrand = async (rid, bid) => {
    if (!window.confirm("Delete brand?")) return;
    await api.delete(`/catalog/range/${rid}/brand/${bid}`);
    load();
  };
  const addSeries = async (rid, bid) => {
    const name = window.prompt("Series name?");
    if (!name) return;
    await api.post(`/catalog/range/${rid}/brand/${bid}/series`, { name });
    load();
  };
  const delSeries = async (rid, bid, sid) => {
    if (!window.confirm("Delete series?")) return;
    await api.delete(`/catalog/range/${rid}/brand/${bid}/series/${sid}`);
    load();
  };

  const uploadPdf = async (rid, bid, sid, file) => {
    const fd = new FormData();
    fd.append("file", file);
    await api.post(`/catalog/range/${rid}/brand/${bid}/series/${sid}/pdf`, fd);
    toast.success("PDF uploaded");
    load();
  };

  return (
    <div className="space-y-4" data-testid="catalog-page">
      <div className="pt-2">
        <h1 className="font-[Manrope] text-3xl font-bold tracking-tight text-gray-900">Catalog</h1>
        <p className="text-sm text-gray-500">Range → Brand → Series → PDF</p>
      </div>

      {/* Add range */}
      <div className="bg-white rounded-3xl border border-gray-200 p-3 flex gap-2">
        <Input
          value={newRange}
          onChange={(e) => setNewRange(e.target.value)}
          placeholder="New product range (e.g. Cables)"
          className="h-11 rounded-full bg-gray-50 border-gray-200 px-4"
          data-testid="new-range-input"
        />
        <Button onClick={addRange} className="rounded-full h-11 bg-emerald-600 hover:bg-emerald-700 press-fx" data-testid="add-range-btn">
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      <Accordion type="multiple" className="space-y-2">
        {ranges.map((r) => (
          <AccordionItem key={r.id} value={r.id} className="bg-white border border-gray-200 rounded-2xl px-4" data-testid={`range-item-${r.id}`}>
            <div className="flex items-center justify-between">
              <AccordionTrigger className="hover:no-underline flex-1">
                <span className="font-[Manrope] font-semibold text-base">{r.name}</span>
                <span className="ml-2 text-xs text-gray-400">({r.brands?.length || 0})</span>
              </AccordionTrigger>
              <button onClick={(e) => { e.stopPropagation(); delRange(r.id); }} className="ml-2 text-red-500" data-testid={`del-range-${r.id}`}>
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <AccordionContent>
              <div className="space-y-2 pb-3">
                {r.brands?.map((b) => (
                  <div key={b.id} className="bg-gray-50 rounded-xl p-3" data-testid={`brand-item-${b.id}`}>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-sm font-semibold">{b.name}</h4>
                      <div className="flex gap-1">
                        <button onClick={() => addSeries(r.id, b.id)} className="text-xs text-emerald-600 px-2" data-testid={`add-series-${b.id}`}>+ series</button>
                        <button onClick={() => delBrand(r.id, b.id)} className="text-xs text-red-500 px-2" data-testid={`del-brand-${b.id}`}>delete</button>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      {b.series?.map((s) => {
                        const key = `${r.id}-${b.id}-${s.id}`;
                        return (
                          <div key={s.id} className="flex items-center gap-2 bg-white rounded-lg px-3 py-2" data-testid={`series-item-${s.id}`}>
                            <span className="text-sm flex-1">{s.name}</span>
                            {s.pdf_id ? (
                              <span className="inline-flex items-center gap-1 text-[10px] bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full">
                                <FileCheck2 className="w-3 h-3" /> PDF
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[10px] bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">
                                <FileX2 className="w-3 h-3" /> No PDF
                              </span>
                            )}
                            <input
                              ref={(el) => (uploadRef.current[key] = el)}
                              type="file"
                              hidden
                              accept=".pdf"
                              onChange={(e) => e.target.files?.[0] && uploadPdf(r.id, b.id, s.id, e.target.files[0])}
                            />
                            <button onClick={() => uploadRef.current[key]?.click()} className="text-emerald-600" data-testid={`upload-pdf-${s.id}`}>
                              <Upload className="w-4 h-4" />
                            </button>
                            <button onClick={() => delSeries(r.id, b.id, s.id)} className="text-red-500" data-testid={`del-series-${s.id}`}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <Button onClick={() => addBrand(r.id)} variant="outline" className="w-full rounded-full h-10 border-dashed press-fx" data-testid={`add-brand-${r.id}`}>
                  <Plus className="w-4 h-4 mr-1" /> Add brand
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}
