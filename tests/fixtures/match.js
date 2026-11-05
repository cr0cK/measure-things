// Matches what Find helpers found against the ground truth of tests/fixtures/images.js.

// The classes of truth each tolerance level has to find.
export const CLASSES = {
    low: ['block'],
    medium: ['block', 'card'],
    high: ['block', 'card', 'element'],
};

const TOLERANCE = 1;
const near = (a, b) => Math.abs(a - b) <= TOLERANCE;

const sameRectangle = (found, truth) =>
    near(found.x, truth.x) && near(found.y, truth.y) &&
    near(found.x + found.width, truth.x + truth.width) &&
    near(found.y + found.height, truth.y + truth.height);

/** The edges of a rectangle as `{axis, position, from, to}`. */
function edgesOf(rect) {
    return [
        {axis: 'vertical', position: rect.x, from: rect.y, to: rect.y + rect.height},
        {axis: 'vertical', position: rect.x + rect.width, from: rect.y, to: rect.y + rect.height},
        {axis: 'horizontal', position: rect.y, from: rect.x, to: rect.x + rect.width},
        {axis: 'horizontal', position: rect.y + rect.height, from: rect.x, to: rect.x + rect.width},
    ];
}

const overlap = (a, b) => Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from));

/** Whether `edge` lies on `other`, within a pixel and over at least half of its length. */
function onEdge(edge, other) {
    return edge.axis === other.axis && near(edge.position, other.position) &&
        overlap(edge, other) >= (edge.to - edge.from) / 2;
}

const guideEdge = guide => (guide.kind === 'vertical'
    ? {axis: 'vertical', position: guide.x} : {axis: 'horizontal', position: guide.y});

/**
 * What a level found against the truth: the truth items of its classes that were not found, and
 * the helpers that match no truth item of any class.
 */
export function compare(truth, found, level) {
    const classes = CLASSES[level];
    const foundEdges = found.rectangles.flatMap(edgesOf);
    const missing = [];
    for (const rect of truth.rectangles.filter(item => classes.includes(item.class))) {
        if (!found.rectangles.some(candidate => sameRectangle(candidate, rect)))
            missing.push({kind: 'rectangle', ...rect});
    }
    for (const edge of truth.edges.filter(item => classes.includes(item.class))) {
        const byGuide = found.guides.some(guide => {
            const wanted = guideEdge(guide);
            return wanted.axis === edge.axis && near(wanted.position, edge.position);
        });
        if (!byGuide && !foundEdges.some(candidate => onEdge(edge, candidate)))
            missing.push({kind: 'edge', ...edge});
    }

    const truthEdges = [...truth.edges, ...truth.rectangles.flatMap(edgesOf)];
    const unmatched = [
        ...found.rectangles.filter(rect => !truth.rectangles.some(item => sameRectangle(rect, item))),
        ...found.guides.filter(guide => {
            const wanted = guideEdge(guide);
            return !truthEdges.some(edge =>
                edge.axis === wanted.axis && near(edge.position, wanted.position));
        }),
    ];
    return {missing, unmatched, helpers: found.rectangles.length + found.guides.length};
}
