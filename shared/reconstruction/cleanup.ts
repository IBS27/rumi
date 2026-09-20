import type { ReconstructedObject, ReconstructedScene } from "./contracts";

// Older room reconstructions fused small, loose props into furniture. Those
// props have no editable instance or collision body, so keep the host usable.
// Separately modeled objects and product assets never pass through this filter.
export function clearFurnitureSurfaces(object: ReconstructedObject): ReconstructedObject {
  if (!/\b(table|nightstand|desk|dresser|cabinet|vanity|counter|bathtub|tub|shelf|shelves|bookcase|bookshelf|rack)\b/i.test(object.label))
    return object;
  const parts = object.parts.filter((part) => {
    const name = `${part.id} ${part.name}`.replace(/[-_]/g, " ");
    if (/\b(rail|rack|bracket|basket|mount|faucet|drain)\b/i.test(name)) return true;
    return !/\b(telephone|phone|handset|tissues?|hairdryer|hair dryer|soap dish|toiletr(?:y|ies)|shampoo|bottles?|remote|books?|magazines?|cups?|mugs?|towels?)\b/i.test(name);
  });
  // Never replace a standalone item or a whole model with an empty assembly.
  if (!parts.length || parts.length === object.parts.length) return object;
  return {
    ...object,
    label: object.label.replace(/\s+with\s+(?:a\s+)?(?:telephone|phone|tissue box)\b.*$/i, ""),
    parts,
  };
}

export function clearEmbeddedDecor(scene: ReconstructedScene): ReconstructedScene {
  return { ...scene, objects: scene.objects.map(clearFurnitureSurfaces) };
}
