---
name: pixerate-diagram-architecture
description: The architecture diagram workflow in the Pixerate diagram editor - drawing systems, services, data stores and external actors with consistent shapes, grouping them into tiers, environments and trust boundaries, labelling data flows with protocols and direction, choosing between a flowchart, C4 and architecture family, and keeping the diagram at one level of detail. Use when asked to draw or document a system, software, cloud, network, infrastructure, deployment or service architecture, a C4 context or container diagram, data flows or trust boundaries, or when load_diagram_mermaid, group_diagram_nodes or set_diagram_edge_label are available. Load with pixerate-diagram, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-diagram
---

# Drawing an architecture

An architecture diagram shows what the parts of a system are, how they are grouped and how data
moves between them, at one level of detail. Users and external systems sit at the edge; tiers,
environments and trust boundaries are groups; every arrow is a flow labelled with what moves
over it and how (HTTPS, SQL, events).

This skill is the method. `pixerate-diagram` has the full tool reference.

## Goal and quality bar

- One level of detail: a context view (people and systems), a container view (apps, services,
  stores) or a deployment view (servers, networks); not all at once.
- Consistent shapes: data stores as `cyl`, people and external actors distinguishable from
  internal services, queues and documents with their own shape.
- Groups for tiers, environments and trust boundaries, labelled ("App tier", "Private
  network").
- Every flow points the way data moves and is labelled with its protocol or content.
- Direction `LR` for request flows (user on the left, data on the right), `TB` for layered
  stacks.

## Inputs to confirm

- **Scope and level:** the whole system or one part; context, container or deployment.
- **The parts**, their kinds (service, store, queue, external) and how they talk.
- **Boundaries** that matter: public versus private, regions, accounts, teams.

## Working method

1. **Read.** `get_diagram` for anything existing; note ids and groups.
2. **List the parts and flows** at one level: actors, services, stores, external systems; each
   flow with source, target and protocol.
3. **Choose the family.** A `flowchart` with subgraphs suits most system sketches; `C4Context` /
   `C4Container` when the user asks for C4; `architecture-beta` for cloud icons and groups.
4. **Write it** with `load_diagram_mermaid`: nodes with shapes, `subgraph` groups, labelled
   edges (`app1 -->|SQL| db`).
   **Check:** `get_diagram`: store shapes, groups and each node's `parentId`, every edge's
   `label`.
5. **Boundaries.** `group_diagram_nodes` for tiers and trust boundaries in an existing diagram.
   **Check:** components sit in the right group; nothing internal is left outside.
6. **Label flows.** `set_diagram_edge_label` with the protocol or content on each edge.
   **Check:** no edge without a label (other than obvious containment).
7. **Look.** `render_diagram`: arrows crossing groups, crowded tiers, long labels.

## Decision table

| Part | Shape |
| --- | --- |
| Service, app, API | `rect` (or `rounded`) |
| Database, data store | `cyl` |
| Queue, stream | `h-cyl` or `lin-cyl` |
| File, document, report | `doc` |
| Person, external actor | `stadium` or `circle`, outside the system's group |
| External system | `rect` with a dashed style, or its own group |
| Tier, environment, boundary | `subgraph` via `group_diagram_nodes` |

| Want | Family |
| --- | --- |
| A quick system sketch | `flowchart LR` with subgraphs |
| A C4 context or container view | `C4Context`, `C4Container` |
| Cloud services with icons and groups | `architecture-beta` |
| Calls over time between services | `sequenceDiagram` |

## Recipes

**Three-tier web app.** `load_diagram_mermaid` with `flowchart LR`, `browser[Browser] -->|HTTPS|
lb[Load balancer]`, a `subgraph app [App tier]` with `app1` and `app2`, `lb --> app1`,
`lb --> app2`, `app1 -->|SQL| db[(Database)]`, `app2 -->|SQL| db`.

**Trust boundaries.** `group_diagram_nodes` `{ nodeIds: ["browser"], label: "Public internet" }`
and `{ nodeIds: ["lb", "api", "db"], label: "Private network" }`.

**Protocols.** `set_diagram_edge_label` on each edge id from `get_diagram` (`L_browser_api_0` →
"HTTPS").

## Pitfalls

- **Mixed levels**: servers next to business capabilities next to classes confuse every reader.
- **Unlabelled arrows** hide what actually flows and over which protocol.
- **Two-way arrows everywhere**: draw the direction of the request or the data.
- **Databases as rectangles** lose the most recognised shape in the diagram.
- **Everything in one group** says nothing; boundaries should separate what differs (trust,
  environment, ownership).
- **Crossing lines** across groups: reorder nodes or change direction.

## Tools used

- `get_diagram`, `render_diagram`: read and look
- `load_diagram_mermaid`: write the architecture in one call
- `add_diagram_node`, `connect_diagram_nodes`, `reconnect_diagram_edge`: change parts and flows
- `set_diagram_node_shape`, `set_diagram_node_style`, `rename_diagram_node`: shapes, styles and names
- `set_diagram_edge_label`: protocols on flows
- `group_diagram_nodes`, `ungroup_diagram_group`: tiers and boundaries
- `move_diagram_nodes`: canvas positions, to untangle crossing lines
- `set_diagram_direction`, `set_diagram_title`: layout and title
- `undo_diagram`: take back a step
