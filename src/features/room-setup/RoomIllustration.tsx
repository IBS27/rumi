/** Empty room outline for the start screen. Colours match the theme tokens. */
export function RoomIllustration({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 -70 860 600"
      role="img"
      aria-label="An empty room outline with a sofa, a plant and a window"
    >
      <polygon points="130,300 470,470 800,305 460,135" fill="#f7f6f2" />
      <polygon
        points="130,300 470,470 800,305 460,135"
        fill="none"
        stroke="#124f49"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <polyline
        points="130,300 130,120 460,-45 800,125 800,305"
        fill="none"
        stroke="#124f49"
        strokeWidth="3"
        strokeDasharray="10 8"
        strokeLinejoin="round"
        opacity=".55"
      />
      <line
        x1="460"
        y1="135"
        x2="460"
        y2="-45"
        stroke="#124f49"
        strokeWidth="3"
        strokeDasharray="10 8"
        opacity=".55"
      />
      <polygon
        points="600,125 710,180 710,100 600,45"
        fill="#d7dfe8"
        stroke="#124f49"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <line
        x1="655"
        y1="152.5"
        x2="655"
        y2="72.5"
        stroke="#124f49"
        strokeWidth="2.5"
      />
      <polygon points="350,320 480,385 650,300 520,235" fill="#e9e2d6" />
      <polygon
        points="195,237.5 275,277.5 485,172.5 405,132.5"
        fill="#3aa396"
      />
      <polygon
        points="275,322.5 485,217.5 485,172.5 275,277.5"
        fill="#2c8a80"
      />
      <polygon
        points="195,282.5 275,322.5 275,277.5 195,237.5"
        fill="#1e6b63"
      />
      <polygon points="195,200.5 215,210.5 425,105.5 405,95.5" fill="#3aa396" />
      <polygon
        points="215,247.5 425,142.5 425,105.5 215,210.5"
        fill="#2c8a80"
      />
      <polygon
        points="195,237.5 215,247.5 215,210.5 195,200.5"
        fill="#124f49"
      />
      <polygon points="195,217.5 275,257.5 290,250 210,210" fill="#3aa396" />
      <polygon points="275,277.5 290,270 290,250 275,257.5" fill="#2c8a80" />
      <polygon
        points="195,237.5 275,277.5 275,257.5 195,217.5"
        fill="#124f49"
      />
      <polygon points="390,120 470,160 485,152.5 405,112.5" fill="#3aa396" />
      <polygon points="470,180 485,172.5 485,152.5 470,160" fill="#2c8a80" />
      <polygon points="390,140 470,180 470,160 390,120" fill="#124f49" />
      <polygon points="680,265 710,280 740,265 710,250" fill="#f1ece2" />
      <polygon points="710,315 740,300 740,265 710,280" fill="#e9e2d6" />
      <polygon points="680,300 710,315 710,280 680,265" fill="#ddd3c2" />
      <line
        x1="710"
        y1="265"
        x2="710"
        y2="210"
        stroke="#124f49"
        strokeWidth="3"
      />
      <ellipse
        cx="692"
        cy="217"
        rx="22"
        ry="12"
        transform="rotate(-30 692 217)"
        fill="#2c8a80"
      />
      <ellipse
        cx="730"
        cy="215"
        rx="22"
        ry="12"
        transform="rotate(30 730 215)"
        fill="#3aa396"
      />
      <ellipse cx="710" cy="193" rx="12" ry="22" fill="#1e6b63" />
      <text
        x="560"
        y="344"
        textAnchor="middle"
        fontFamily="DM Sans, sans-serif"
        fontSize="14"
        fill="#124f49"
        opacity=".75"
      >
        your room goes here
      </text>
    </svg>
  );
}
