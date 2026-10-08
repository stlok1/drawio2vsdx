# drawio2vsdx

Converts draw.io diagrams (`.drawio`) to Microsoft Visio files (`.vsdx`) made of native, editable Visio shapes — not embedded images.

Each draw.io vertex becomes a Visio shape with its own geometry, fill, line and formatted text; each edge becomes a 1-D line shape with arrowheads and a label. Multi-page diagrams become multi-page Visio documents.

## Quick start

Requires Node.js and npm.

```bash
git clone https://github.com/stlok1/drawio2vsdx.git
cd drawio2vsdx
npm install
npm run convert -- diagram.drawio
```

This writes `diagram.vsdx` next to the input file.

## Usage

```text
npm run convert -- <input.drawio> [-o output.vsdx] [--split]
```

| Option | Effect |
|---|---|
| `-o <file>` | Output path. Defaults to the input path with a `.vsdx` extension. |
| `--split` | Write one `.vsdx` per draw.io page instead of one multi-page file. Files are named `<output>-01.vsdx`, `<output>-02.vsdx`, … |

Examples:

```bash
npm run convert -- docs/flow.drawio -o out/flow.vsdx
npm run convert -- docs/flow.drawio --split
```

The CLI prints each file it writes and its page count. Lines starting with `warn:` flag labels that may not fit their box in Visio.

To get a `drawio2vsdx` command on the `PATH`, link the package once:

```bash
npm link
drawio2vsdx diagram.drawio -o diagram.vsdx
```

## What gets converted

**Pages**

- Every `<diagram>` in the file, both compressed and uncompressed.
- Page name and page size (`pageWidth` / `pageHeight`).

**Shapes**

| draw.io shape | Visio result |
|---|---|
| Rectangle | Rectangle |
| Rounded rectangle (`rounded=1`) | Rectangle with arc corners, honouring `arcSize` and `absoluteArcSize` |
| Ellipse | Ellipse |
| Rhombus | Diamond |
| Note | Rectangle with a folded corner |
| Swimlane | Rectangle with a header divider; the label sits in the header |
| Text | Shape with no fill and no line |
| Anything else | Rectangle |

Fill colour, stroke colour, stroke width, dashed lines and locked cells are carried over. Child shapes nested in containers are placed at their absolute position.

**Connectors**

- Straight edges and orthogonal edges (`orthogonalEdgeStyle`, `elbowEdgeStyle`, `entityRelationEdgeStyle`), with waypoints.
- Fixed connection points (`exitX`/`exitY`, `entryX`/`entryY`) and floating ends, which attach to the side facing the other shape. Ends on ellipses and rhombuses land on the outline.
- Arrowheads (`classic`, `block`, `open`, `diamond`, `oval`, filled and unfilled) and their sizes.
- Rounded corners, dashed lines, stroke colour and width.
- Labels, positioned along the edge with their offset and background colour.

**Text**

- Plain labels and HTML labels (`html=1`): `<b>`, `<i>`, `<u>`, `<font>`, `<br>`, `<div>`, `<p>`, `<li>` and inline `style` with colour, font size, weight, style, family and underline.
- Font family, size, colour, bold / italic / underline, horizontal and vertical alignment, spacing and label background.
- Fonts are mapped to ones Visio has (Helvetica → Arial, Courier → Courier New, Times → Times New Roman).

## Limitations

- Connectors are drawn as fixed polylines. They are not glued to the shapes, so they don't follow a shape that is moved in Visio.
- Rotation and flipping are ignored.
- Images, curved edges, gradients, shadows and stencil-library shapes are not converted; unrecognised shapes come out as rectangles.
- The page background colour is not applied.
- The document language is set to `pl-PL`.
- Text widths are measured with Liberation Sans or Arial, looked up in the standard font folders on Linux, Windows and macOS. If neither is installed, widths are estimated and labels may wrap differently.

## How it works

```text
.drawio ──► model.ts ──► route.ts ──► vsdx.ts ──► .vsdx
            parse        edge paths   OPC package
```

| File | Role |
|---|---|
| `src/cli.ts` | Argument parsing, file reading and writing. |
| `src/model.ts` | Parses the `mxfile` XML into pages of vertices and edges with absolute coordinates. |
| `src/richtext.ts` | Turns plain and HTML labels into styled text runs; normalises colours and font names. |
| `src/measure.ts` | Measures text with `opentype.js` to size text blocks and edge labels. |
| `src/route.ts` | Rebuilds the path of each edge as an explicit polyline, since draw.io computes it at render time and doesn't store it. |
| `src/vsdx.ts` | Writes shapes, pages and document parts into a `.vsdx` zip. |

One draw.io pixel maps to 1/96 inch, so shapes and font sizes keep their proportions.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # compile src/ to dist/
```

`npm run convert` runs the TypeScript sources directly with `tsx`. The `drawio2vsdx` command runs the compiled `dist/cli.js`, which `npm install` builds automatically; after changing anything in `src/`, run `npm run build` again to update the command. There are no automated tests.

## License

MIT — see [LICENSE](LICENSE).
