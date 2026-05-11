import { useEffect, useState } from "react";
import api from "@/lib/api";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { ArrowLeft, Plus, Pencil, Trash2, Users, Search, Send, X } from "lucide-react";

const SOURCE_LABEL = { manual: "Manual", imported: "Imported", bot: "Bot Lead" };

export default function Groups() {
  const [groups, setGroups] = useState([]);
  const [q, setQ] = useState("");
  const [openGroup, setOpenGroup] = useState(null); // { id, name, contacts }
  const [renaming, setRenaming] = useState(null); // { id, name }
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  // Add-contacts picker state (server-side search — scales to 40k+ contacts)
  const [picker, setPicker] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerResults, setPickerResults] = useState([]);  // current page (max 200)
  const [pickerTotal, setPickerTotal] = useState(0);        // total matching server-side
  const [pickerSrcFilter, setPickerSrcFilter] = useState("all");
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerSel, setPickerSel] = useState({});           // {id: contactObj}  — persists across searches

  const nav = useNavigate();

  const loadGroups = async () => {
    const r = await api.get("/groups", { params: { q: q || undefined } });
    setGroups(r.data);
  };

  useEffect(() => {
    const t = setTimeout(loadGroups, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [q]);

  const openDetails = async (g) => {
    const r = await api.get(`/groups/${g.id}`);
    setOpenGroup(r.data);
  };

  const create = async () => {
    if (!newName.trim()) return toast.error("Group name required");
    await api.post("/groups", { name: newName.trim() });
    toast.success("Group created");
    setNewName("");
    setCreating(false);
    loadGroups();
  };

  const rename = async () => {
    if (!renaming.name?.trim()) return toast.error("Name required");
    await api.put(`/groups/${renaming.id}`, { name: renaming.name.trim() });
    toast.success("Renamed");
    setRenaming(null);
    loadGroups();
    if (openGroup) openDetails({ id: openGroup.id });
  };

  const removeGroup = async (id) => {
    if (!window.confirm("Delete this group? Contacts stay safe — only the group is removed.")) return;
    await api.delete(`/groups/${id}`);
    setOpenGroup(null);
    loadGroups();
  };

  const removeContactFromGroup = async (cid) => {
    await api.delete(`/groups/${openGroup.id}/contacts/${cid}`);
    openDetails({ id: openGroup.id });
  };

  const openContactPicker = () => {
    setPickerSel({});
    setPickerSearch("");
    setPickerSrcFilter("all");
    setPicker(true);
  };

  // Server-side search — re-queries the API when search or filter changes.
  // Loads max 200 results per query; if more match, user must narrow search.
  useEffect(() => {
    if (!picker) return;
    setPickerLoading(true);
    const t = setTimeout(async () => {
      try {
        const params = { limit: 200 };
        if (pickerSearch.trim()) params.q = pickerSearch.trim();
        if (pickerSrcFilter !== "all") params.source = pickerSrcFilter;
        const r = await api.get("/contacts", { params });
        setPickerResults(r.data.items || []);
        setPickerTotal(r.data.total || 0);
      } catch {
        setPickerResults([]);
        setPickerTotal(0);
      } finally {
        setPickerLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [picker, pickerSearch, pickerSrcFilter]);

  const commitAdd = async () => {
    const ids = Object.keys(pickerSel);
    if (ids.length === 0) {
      setPicker(false);
      return;
    }
    try {
      const r = await api.post(`/groups/${openGroup.id}/contacts`, { contact_ids: ids });
      toast.success(`Group now has ${r.data.count} contacts`);
      setPicker(false);
      openDetails({ id: openGroup.id });
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed (50 contact cap)");
    }
  };

  const alreadyIn = new Set(openGroup?.contacts?.map((c) => c.id) || []);
  const selectedCount = Object.keys(pickerSel).length;

  const startBlastFromGroup = () => {
    const ids = (openGroup?.contacts || []).map((c) => c.id);
    sessionStorage.setItem("ve_blast_from_group", JSON.stringify({
      group_id: openGroup.id,
      group_name: openGroup.name,
      contacts: openGroup.contacts.map((c) => ({ phone: c.mobile, name: c.name || c.shop_name || c.mobile })),
    }));
    nav("/?from_group=1");
  };

  return (
    <div className="space-y-4" data-testid="groups-page">
      <div className="flex items-center gap-3 pt-2">
        <button onClick={() => nav(-1)} className="w-10 h-10 rounded-full bg-white border border-gray-200 flex items-center justify-center press-fx" data-testid="back-btn">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="font-[Manrope] text-2xl font-bold tracking-tight text-gray-900">Groups</h1>
          <p className="text-xs text-gray-500">{groups.length} groups • 50 contact cap each</p>
        </div>
        <Button onClick={() => setCreating(true)} className="rounded-full h-10 bg-emerald-600 hover:bg-emerald-700 press-fx" data-testid="new-group-btn">
          <Plus className="w-4 h-4 mr-1" /> New
        </Button>
      </div>

      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search groups by name" className="pl-9 h-12 rounded-full bg-white border-gray-200" data-testid="groups-search" />
      </div>

      <div className="space-y-2" data-testid="groups-list">
        {groups.length === 0 && (
          <div className="bg-white rounded-2xl p-8 text-center text-sm text-gray-500 border border-dashed border-gray-300">
            No groups yet. Tap <strong>+ New</strong> to create one.
          </div>
        )}
        {groups.map((g) => (
          <div key={g.id} className="bg-white border border-gray-200 rounded-2xl p-3 flex items-center gap-3 press-fx" onClick={() => openDetails(g)} data-testid={`group-${g.id}`}>
            <div className="w-12 h-12 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center shrink-0">
              <Users className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-[Manrope] font-semibold text-base truncate">{g.name}</h3>
              <p className="text-xs text-gray-500">{g.count} / 50 contacts</p>
            </div>
            <button onClick={(e) => { e.stopPropagation(); setRenaming({ id: g.id, name: g.name }); }} className="w-9 h-9 rounded-full bg-gray-100 text-gray-600 flex items-center justify-center press-fx" data-testid={`rename-${g.id}`}>
              <Pencil className="w-4 h-4" />
            </button>
            <button onClick={(e) => { e.stopPropagation(); removeGroup(g.id); }} className="w-9 h-9 rounded-full bg-red-50 text-red-600 flex items-center justify-center press-fx" data-testid={`del-${g.id}`}>
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      {/* Create dialog */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-sm rounded-3xl">
          <DialogHeader>
            <DialogTitle>New group</DialogTitle>
            <DialogDescription>Up to 50 contacts per group</DialogDescription>
          </DialogHeader>
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Surat Wholesalers" className="h-11 rounded-2xl" data-testid="new-group-name" />
          <Button onClick={create} className="w-full h-11 rounded-full bg-emerald-600 hover:bg-emerald-700" data-testid="create-group-btn">Create</Button>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="max-w-sm rounded-3xl">
          <DialogHeader><DialogTitle>Rename group</DialogTitle></DialogHeader>
          {renaming && (
            <>
              <Input value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} className="h-11 rounded-2xl" data-testid="rename-input" />
              <Button onClick={rename} className="w-full h-11 rounded-full bg-emerald-600 hover:bg-emerald-700" data-testid="rename-save">Save</Button>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Group details modal */}
      <Dialog open={!!openGroup} onOpenChange={(o) => !o && setOpenGroup(null)}>
        <DialogContent className="max-w-md rounded-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {openGroup?.name}
              <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">{openGroup?.count || 0}/50</span>
            </DialogTitle>
            <DialogDescription>Manage members &amp; blast to all at once</DialogDescription>
          </DialogHeader>
          {openGroup && (
            <div className="space-y-3">
              <div className="flex gap-2">
                <Button onClick={openContactPicker} className="flex-1 h-10 rounded-full bg-emerald-600 hover:bg-emerald-700 press-fx" data-testid="add-to-group-btn">
                  <Plus className="w-4 h-4 mr-1" /> Add contacts
                </Button>
                <Button onClick={startBlastFromGroup} disabled={!openGroup.count} variant="outline" className="flex-1 h-10 rounded-full border-blue-300 text-blue-700 press-fx" data-testid="blast-group-btn">
                  <Send className="w-4 h-4 mr-1" /> Blast
                </Button>
              </div>
              <div className="space-y-1.5 max-h-[50vh] overflow-auto" data-testid="group-members-list">
                {(openGroup.contacts || []).length === 0 && <p className="text-center text-sm text-gray-400 py-6">No members yet</p>}
                {(openGroup.contacts || []).map((c) => (
                  <div key={c.id} className="flex items-center gap-2 bg-gray-50 rounded-xl p-2.5">
                    <div className="w-9 h-9 rounded-full bg-emerald-600 text-white text-xs font-bold flex items-center justify-center">
                      {(c.name || c.mobile || "?").trim().slice(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{c.name || c.shop_name || "Unnamed"}</div>
                      <div className="text-xs text-gray-500 truncate">+{c.mobile} • {c.city}</div>
                    </div>
                    <button onClick={() => removeContactFromGroup(c.id)} className="w-8 h-8 rounded-full bg-red-50 text-red-500 flex items-center justify-center" data-testid={`remove-member-${c.id}`}>
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Add contacts picker — server-side search, scales to 40k+ contacts */}
      <Dialog open={picker} onOpenChange={setPicker}>
        <DialogContent className="max-w-md rounded-3xl">
          <DialogHeader>
            <DialogTitle>Add contacts</DialogTitle>
            <DialogDescription>
              {pickerLoading
                ? "Searching..."
                : `Showing ${pickerResults.length} of ${pickerTotal.toLocaleString()} matching contacts`}
              {selectedCount > 0 && ` • ${selectedCount} selected`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                value={pickerSearch}
                onChange={(e) => setPickerSearch(e.target.value)}
                placeholder="Search name, mobile, city, state..."
                className="pl-9 h-10 rounded-full"
                data-testid="picker-search"
                autoFocus
              />
            </div>
            <Select value={pickerSrcFilter} onValueChange={setPickerSrcFilter}>
              <SelectTrigger className="w-28 rounded-full h-10" data-testid="picker-source-filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="manual">Manual</SelectItem>
                <SelectItem value="imported">Imported</SelectItem>
                <SelectItem value="bot">Bot</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {pickerResults.length > 0 && (
            <div className="flex items-center justify-between text-xs px-1">
              <button
                type="button"
                onClick={() => {
                  const next = { ...pickerSel };
                  pickerResults
                    .filter((c) => !alreadyIn.has(c.id))
                    .forEach((c) => { next[c.id] = c; });
                  setPickerSel(next);
                }}
                className="text-emerald-700 font-semibold press-fx"
                data-testid="picker-select-all"
              >
                Select all {pickerResults.filter((c) => !alreadyIn.has(c.id)).length} shown
              </button>
              <button
                type="button"
                onClick={() => setPickerSel({})}
                className="text-gray-500 press-fx"
                data-testid="picker-clear-sel"
              >
                Clear selection
              </button>
            </div>
          )}
          {pickerTotal > pickerResults.length && (
            <p className="text-[11px] text-amber-600 px-1">
              ⚠ {(pickerTotal - pickerResults.length).toLocaleString()} more contacts match — narrow your search to see them.
            </p>
          )}
          <div className="max-h-[55vh] overflow-auto space-y-1.5" data-testid="picker-contacts">
            {pickerLoading && pickerResults.length === 0 && (
              <div className="text-center text-sm text-gray-400 py-8">Loading...</div>
            )}
            {!pickerLoading && pickerResults.length === 0 && (
              <div className="text-center text-sm text-gray-500 py-8">
                {pickerSearch ? `No contacts match "${pickerSearch}"` : "No contacts yet — add some from the Contacts page first."}
              </div>
            )}
            {pickerResults.map((c) => {
              const inGroup = alreadyIn.has(c.id);
              const selected = !!pickerSel[c.id];
              return (
                <label key={c.id} className={`flex items-center gap-2 p-2 rounded-xl ${inGroup ? "bg-emerald-50 opacity-50" : "bg-gray-50 cursor-pointer"}`}>
                  <input
                    type="checkbox"
                    className="w-5 h-5 accent-emerald-600"
                    checked={inGroup || selected}
                    disabled={inGroup}
                    onChange={(e) => {
                      const next = { ...pickerSel };
                      if (e.target.checked) next[c.id] = c;
                      else delete next[c.id];
                      setPickerSel(next);
                    }}
                    data-testid={`pick-${c.id}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{c.name || c.shop_name || c.mobile}</div>
                    <div className="text-xs text-gray-500 truncate">+{c.mobile} • {c.city} • {SOURCE_LABEL[c.source] || c.source}</div>
                  </div>
                </label>
              );
            })}
          </div>
          <Button
            onClick={commitAdd}
            disabled={selectedCount === 0}
            className="w-full h-11 rounded-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50"
            data-testid="commit-add-btn"
          >
            Add {selectedCount} selected
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
