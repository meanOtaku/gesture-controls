import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { describeDesign, duplicateOf, isBuiltIn, newDesign, type DesignPreview, type NetworkDesign } from "../designs";
import { DesignEditor } from "./DesignEditor";

const PREVIEW_DELAY_MS = 250;

/**
 * Network designs: the recipes a model is trained with. Built-in ones come with the app; your own can be made from scratch or
 * by duplicating one, edited with the numbers of inputs, layers and parameters following, and saved to be used when
 * training. A design says nothing about which label or recordings.
 */
export function NetworkDesigns({ desktopAvailable }: { desktopAvailable: boolean }) {
  const [designs, setDesigns] = useState<NetworkDesign[]>([]);
  const [previews, setPreviews] = useState<Record<string, DesignPreview>>({});
  const [draft, setDraft] = useState<NetworkDesign | null>(null);
  const [draftPreview, setDraftPreview] = useState<DesignPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async (next?: NetworkDesign[]) => {
    try {
      const list = next ?? (await invoke<NetworkDesign[]>("list_network_designs"));
      setDesigns(Array.isArray(list) ? list : []);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    if (desktopAvailable) void load();
  }, [desktopAvailable, load]);

  // What each saved design reads, for its line in the list.
  useEffect(() => {
    let stale = false;
    void Promise.all(designs.map(async (design) => [design.id, await invoke<DesignPreview>("preview_network_design", { design }).catch(() => null)] as const)).then((pairs) => {
      if (!stale) setPreviews(Object.fromEntries(pairs.filter((pair): pair is [string, DesignPreview] => pair[1] !== null)));
    });
    return () => { stale = true; };
  }, [designs]);

  // What the design being edited reads, as it is edited.
  useEffect(() => {
    if (!draft) {
      setDraftPreview(null);
      return;
    }
    let stale = false;
    const timer = window.setTimeout(() => {
      void invoke<DesignPreview>("preview_network_design", { design: draft })
        .then((found) => { if (!stale) setDraftPreview(found); })
        .catch((err) => { if (!stale) setDraftPreview({ problem: String(err), available: [], inputs: [], neurons: 0 }); });
    }, PREVIEW_DELAY_MS);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [draft]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const list = await invoke<NetworkDesign[]>("save_network_design", { design: draft });
      await load(list);
      setDraft(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const list = await invoke<NetworkDesign[]>("delete_network_design", { id });
      await load(list);
      setConfirmDelete(null);
      if (draft?.id === id) setDraft(null);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Card id="lab-designs" role="region" aria-label="Network designs" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Network designs"
          description="Recipes for the network a model is trained with: what goes in, the layers, how it learns."
          status={<Button type="button" disabled={!desktopAvailable || draft !== null} onClick={() => { setDraft(newDesign()); setError(null); }}>New design</Button>}
          help={{ label: "About network designs", content: "A design is a named recipe for a network: the columns or statistics it reads, how many readings of each, how the pulse sensor's spikes are pulled out, the window length, and the layers and learning settings. It says nothing about which label or recordings, so the same design can teach any label. The built-in designs come with the app; your own are kept on this computer." }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && draft === null && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <ul className="flex flex-col gap-3" aria-label="Designs">
          {designs.map((design) => (
            <li key={design.id} className="flex flex-col gap-1 rounded-lg border border-input p-3">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{design.name}</strong>
                {isBuiltIn(design) && <Badge variant="secondary">Built in</Badge>}
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" variant="outline" aria-label={`${isBuiltIn(design) ? "View" : "Edit"} ${design.name}`} onClick={() => { setDraft(design); setError(null); }}>{isBuiltIn(design) ? "View" : "Edit"}</Button>
                  <Button type="button" size="sm" variant="outline" aria-label={`Duplicate ${design.name}`} disabled={draft !== null} onClick={() => { setDraft(duplicateOf(design)); setError(null); }}>Duplicate</Button>
                  {!isBuiltIn(design) && (confirmDelete === design.id ? (
                    <>
                      <Button type="button" size="sm" variant="destructive" aria-label={`Delete ${design.name} for good`} onClick={() => void remove(design.id)}>Delete for good</Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => setConfirmDelete(null)}>Keep</Button>
                    </>
                  ) : (
                    <Button type="button" size="sm" variant="ghost" aria-label={`Delete ${design.name}`} onClick={() => setConfirmDelete(design.id)}>Delete</Button>
                  ))}
                </div>
              </div>
              {design.description && <p className="text-sm">{design.description}</p>}
              <p className="text-xs text-muted-foreground">{describeDesign(design, previews[design.id] ?? null)}</p>
            </li>
          ))}
          {designs.length === 0 && <li className="hint">No designs yet.</li>}
        </ul>
        {draft && <DesignEditor design={draft} onChange={setDraft} preview={draftPreview} onSave={() => void save()} onCancel={() => { setDraft(null); setError(null); }} saving={saving} error={error} />}
      </CardContent>
    </Card>
  );
}
