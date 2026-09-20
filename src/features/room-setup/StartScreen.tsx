import type { ReactNode } from "react";
import { Download, House, Smartphone } from "lucide-react";
import { Display, Heading, Muted, cx } from "../../ui";
import { RoomIllustration } from "./RoomIllustration";

type Tint = "blue" | "stone" | "blush";
const tints: Record<Tint, string> = {
  blue: "bg-blue text-[#2e4656]",
  stone: "bg-stone text-[#5a5044]",
  blush: "bg-blush text-[#6a4a44]",
};

/** One way to bring a room in. Icon, name, one line of explanation. */
export function StartAction({
  icon,
  tint,
  title,
  children,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  tint: Tint;
  title: string;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="grid w-full grid-cols-[44px_1fr] items-start gap-3.5 rounded-[14px] border-[1.5px] border-line bg-white p-4 text-left transition-colors hover:enabled:border-line-strong disabled:opacity-45 cursor-pointer disabled:cursor-default"
    >
      <span
        className={cx(
          "grid size-11 place-items-center rounded-tile [&>svg]:size-[22px]",
          tints[tint],
        )}
      >
        {icon}
      </span>
      <span>
        <strong className="block text-[15px] font-semibold">{title}</strong>
        <Muted className="mt-0.5 block">{children}</Muted>
      </span>
    </button>
  );
}

/**
 * Shown when no room is open. `scan` is the rendered phone-pairing tile
 * (see ScanAction); leave it out when pairing is not configured.
 */
export function StartScreen({
  onImport,
  onSample,
  scan,
  busy,
}: {
  onImport: () => void;
  onSample: () => void;
  scan?: ReactNode;
  busy?: boolean;
}) {
  return (
    <div className="grid flex-1 min-h-0 grid-cols-[1fr_380px] gap-7 px-7 pt-2 pb-7 max-lg:grid-cols-1">
      <div className="relative flex min-h-[420px] flex-col overflow-hidden rounded-panel bg-sage">
        <div className="absolute top-7 left-8 max-w-[34ch]">
          <Display>Bring in a room and we'll furnish it.</Display>
          <p className="mt-3 max-w-[30ch] text-base text-[#3f5049]">
            Scan it with your iPhone or import a RoomPlan file. Then set a style
            and a budget, and the designer picks real products that fit.
          </p>
        </div>
        <RoomIllustration className="mt-auto ml-auto block h-auto w-[86%]" />
        <div className="absolute bottom-6 left-8 inline-flex items-center gap-2.5 rounded-tile border-[1.5px] border-dashed border-teal-deep/45 bg-chalk/60 px-3.5 py-2.5 font-medium text-teal-deep">
          <Download size={18} />
          Drop a RoomPlan file anywhere on this page
        </div>
      </div>

      <div className="flex flex-col gap-3 pt-1.5">
        <Heading className="mb-1 text-[22px]">Start with your room</Heading>
        {scan}
        <StartAction
          icon={<Download />}
          tint="stone"
          title="Import a scan"
          disabled={busy}
          onClick={onImport}
        >
          A Rumi scan ZIP with captured surfaces, or a RoomPlan JSON layout.
        </StartAction>
        <StartAction
          icon={<House />}
          tint="blush"
          title="Open the sample room"
          onClick={onSample}
        >
          The corner living room, sample data. Good for a first look.
        </StartAction>
        <Muted className="mt-auto text-xs">
          Rooms you open are saved on this browser until you sign in.
        </Muted>
      </div>
    </div>
  );
}

/** The phone-pairing tile. Pass it to StartScreen through `scan`. */
export function ScanAction({
  onClick,
  disabled,
  note = "Opens pairing. Rumi walks you through the scan on your phone.",
}: {
  onClick: () => void;
  disabled?: boolean;
  note?: string;
}) {
  return (
    <StartAction
      icon={<Smartphone />}
      tint="blue"
      title="Scan with iPhone"
      disabled={disabled}
      onClick={onClick}
    >
      {note}
    </StartAction>
  );
}
