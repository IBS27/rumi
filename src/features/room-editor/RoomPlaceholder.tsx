export function RoomPlaceholder() {
  return (
    <section className="room-placeholder" aria-labelledby="room-heading">
      <div className="room-description">
        <h2 id="room-heading">3D room model</h2>
        <p>
          The user's room will appear here, built from room photos, a floor
          plan, and confirmed dimensions.
        </p>
        <p>
          It will show existing furniture and recommended products at their
          intended size and placement.
        </p>
        <p>
          Users will be able to explore the room, switch to an overhead view,
          select items, and adjust the layout.
        </p>
      </div>
    </section>
  );
}
