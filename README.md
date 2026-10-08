# drawio2vsdx

Konwerter diagramów **draw.io (`.drawio`) → Visio (`.vsdx`)**, który generuje natywne kształty Visio zamiast korzystać z eksportu VSDX (beta) z draw.io. Po otwarciu w Visio tekst się nie nakłada, a układ zgadza się z oryginałem.

## Instalacja

Wymagany Node.js 18+.

```bash
git clone <url-repo> && cd drawio2vsdx
npm install
```

## Użycie

```bash
npm run convert -- diagram.drawio                    # -> diagram.vsdx (wszystkie strony)
npm run convert -- diagram.drawio -o out/plik.vsdx   # własna ścieżka
npm run convert -- diagram.drawio --split            # osobny .vsdx na każdą stronę
```

Cały folder (PowerShell):

```powershell
Get-ChildItem .\diagramy -Filter *.drawio | ForEach-Object { npm run convert -- $_.FullName }
```

Obsługuje pliki `.drawio` zapisane zarówno jako zwykły XML, jak i skompresowane.

## Jak to działa

- etykiety HTML (`<b>`, `<i>`, `<br>`, `<span style>`) są zamieniane na sformatowany tekst Visio,
- marginesy tekstu są ustawiane tak jak `spacing` w draw.io, a Helvetica jest mapowana na Arial (te same metryki),
- współrzędne zagnieżdżonych kontenerów i swimlane'ów są przeliczane na absolutne,
- trasy strzałek (`orthogonalEdgeStyle`, punkty pośrednie, `exitX/entryX`) są liczone w konwerterze i zapisywane jako linie 1-D,
- skala to 1 px draw.io = 1/96 cala.

## Ograniczenia

- **Obsługiwane:** prostokąty (także zaokrąglone), elipsy, romby, `note`, `swimlane`, `text`, kontenery, strzałki proste i ortogonalne z etykietami.
- **Nieobsługiwane:** obrazki, stencile draw.io (AWS/Azure/BPMN…), gradienty, cienie, styl „sketch”, krzywe strzałki. Wychodzą jako prostokąty.
- Strzałki **nie są przyklejone** do kształtów. Źródłem prawdy powinien zostać `.drawio`: edytujesz w draw.io i konwertujesz ponownie.
- Komunikat `warn: ... may overflow its box` oznacza, że tekst może nie zmieścić się w kształcie. Warto go sprawdzić w Visio.

## Struktura

| Plik | Rola |
|---|---|
| `src/cli.ts` | CLI |
| `src/model.ts` | parsowanie `.drawio`, dekompresja, współrzędne |
| `src/richtext.ts` | etykiety HTML → fragmenty tekstu, fonty, kolory |
| `src/route.ts` | trasy strzałek |
| `src/measure.ts` | pomiar tekstu |
| `src/vsdx.ts` | zapis pakietu `.vsdx` |
| `render.sh` | opcjonalny podgląd PNG przez LibreOffice (bash) |

Podgląd w LibreOffice potrafi przesunąć pogrubienie o kilka liter w etykietach ze znakami spoza ASCII. To błąd LibreOffice, nie pliku. Ostatecznym sprawdzianem jest Visio.

## Dokumentacja formatu

- [MS-VSDX: specyfikacja formatu Visio](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-vsdx/)
- [Visio ShapeSheet: sekcja Character](https://learn.microsoft.com/en-us/office/client-developer/visio/character-section)
