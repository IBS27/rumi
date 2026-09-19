export function Sidebar() {
  return (
    <aside className="sidebar" aria-label="Planned sidebar">
      <h1>Sidebar</h1>
      <p className="intro">
        Placeholders for the room setup and design workflow.
      </p>

      <section>
        <h2>Room setup</h2>
        <p>
          Room photos, an optional floor plan, dimensions, doors, and windows.
        </p>
      </section>
      <section>
        <h2>Existing furniture</h2>
        <p>
          Furniture the user already owns, its placement, and items to keep.
        </p>
      </section>
      <section>
        <h2>Preferences & budget</h2>
        <p>
          The design prompt, aesthetic, spending limit, and room restrictions.
        </p>
      </section>
      <section>
        <h2>Agent conversation</h2>
        <p>
          Follow-up questions, search progress, feedback, and requested changes.
        </p>
      </section>
      <section>
        <h2>Product recommendations</h2>
        <p>
          Suggested items with images, prices, dimensions, and merchant links.
        </p>
      </section>
      <section>
        <h2>Selected item</h2>
        <p>Details and placement of the item selected in the room.</p>
      </section>
      <section>
        <h2>Budget summary</h2>
        <p>The cost of selected items and the remaining budget.</p>
      </section>
    </aside>
  );
}
