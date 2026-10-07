Project 0 diagram sources and exports

Four diagram pairs are included:
- architecture.mmd / architecture.svg
- authorization_sequence.mmd / authorization_sequence.svg
- lifecycle.mmd / lifecycle.svg
- cloud_evolution.mmd / cloud_evolution.svg

Edit the .mmd files with a Mermaid-capable editor for logical diagram changes.
The SVG files are vector artwork with explicit editable coordinates, readable
labels, accessible title/description text, and the course navy/teal palette.
They can be opened directly in a browser or inserted into slides.

export_svg.py uses only Python's standard library to reproduce the companion
SVG artwork with fixed classroom-friendly layout:
  python3 docs/diagrams/export_svg.py

The explicit SVG layouts are maintained alongside the Mermaid representations;
the script is not a general Mermaid parser. When changing the logical design,
update the Mermaid file and the corresponding SVG/script labels and arrows.
The documents contain independent editable TikZ versions of the diagrams.

The cloud diagram distinguishes the working local package, an unchanged
container deployment runbook, and future independently deployed participants.
No cloud resources have been provisioned.
