export type CronScheduleMode =
  | "none"
  | "every"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "custom";

export type CronEveryUnit = "minutes" | "hours";

export type CronScheduleBuilder = {
  mode: CronScheduleMode;
  expression: string;
  interval: number;
  unit: CronEveryUnit;
  time: string;
  weekday: string;
  dayOfMonth: number;
  customExpression: string;
};

export const CRON_WEEKDAY_OPTIONS = [
  { value: "1", label: "Lundi" },
  { value: "2", label: "Mardi" },
  { value: "3", label: "Mercredi" },
  { value: "4", label: "Jeudi" },
  { value: "5", label: "Vendredi" },
  { value: "6", label: "Samedi" },
  { value: "0", label: "Dimanche" },
] as const;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizePositiveInteger(value: number, fallback: number, maximum = 31) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return clamp(Math.trunc(value), 1, maximum);
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function normalizeTime(value: string, fallback = "09:00") {
  const match = value.trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) {
    return fallback;
  }
  const hour = clamp(Number(match[1]), 0, 23);
  const minute = clamp(Number(match[2]), 0, 59);
  return `${pad2(hour)}:${pad2(minute)}`;
}

function timeToCronParts(value: string) {
  const normalized = normalizeTime(value);
  const [hour, minute] = normalized.split(":").map(Number);
  return {
    hour,
    minute,
    normalized,
  };
}

function createDefaultBuilder(): CronScheduleBuilder {
  return {
    mode: "none",
    expression: "",
    interval: 15,
    unit: "minutes",
    time: "09:00",
    weekday: "1",
    dayOfMonth: 1,
    customExpression: "",
  };
}

export function buildCronScheduleExpression(builder: CronScheduleBuilder) {
  switch (builder.mode) {
    case "none":
      return "";
    case "every":
      return builder.unit === "minutes"
        ? `*/${normalizePositiveInteger(builder.interval, 15, 59)} * * * *`
        : `0 */${normalizePositiveInteger(builder.interval, 1, 23)} * * *`;
    case "daily": {
      const { hour, minute } = timeToCronParts(builder.time);
      return `${minute} ${hour} * * *`;
    }
    case "weekdays": {
      const { hour, minute } = timeToCronParts(builder.time);
      return `${minute} ${hour} * * 1-5`;
    }
    case "weekly": {
      const { hour, minute } = timeToCronParts(builder.time);
      const weekday = CRON_WEEKDAY_OPTIONS.some((option) => option.value === builder.weekday)
        ? builder.weekday
        : "1";
      return `${minute} ${hour} * * ${weekday}`;
    }
    case "monthly": {
      const { hour, minute } = timeToCronParts(builder.time);
      const day = normalizePositiveInteger(builder.dayOfMonth, 1, 31);
      return `${minute} ${hour} ${day} * *`;
    }
    case "custom":
      return builder.customExpression.trim();
    default:
      return "";
  }
}

export function parseCronScheduleBuilder(schedule: string) {
  const expression = schedule.trim();
  const base = createDefaultBuilder();
  if (!expression) {
    return base;
  }

  const everyHumanMatch = expression.match(/^every\s+(\d+)\s*([mh])$/i);
  if (everyHumanMatch) {
    const unit = everyHumanMatch[2].toLowerCase() === "h" ? "hours" : "minutes";
    const interval = normalizePositiveInteger(
      Number(everyHumanMatch[1]),
      unit === "hours" ? 1 : 15,
      unit === "hours" ? 23 : 59,
    );
    return {
      ...base,
      mode: "every",
      expression,
      interval,
      unit,
    };
  }

  const cronEveryMinutesMatch = expression.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (cronEveryMinutesMatch) {
    return {
      ...base,
      mode: "every",
      expression,
      interval: normalizePositiveInteger(Number(cronEveryMinutesMatch[1]), 15, 59),
      unit: "minutes",
    };
  }

  const cronEveryHoursMatch = expression.match(/^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (cronEveryHoursMatch) {
    return {
      ...base,
      mode: "every",
      expression,
      interval: normalizePositiveInteger(Number(cronEveryHoursMatch[1]), 1, 23),
      unit: "hours",
    };
  }

  const weekdaysMatch = expression.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+1-5$/);
  if (weekdaysMatch) {
    return {
      ...base,
      mode: "weekdays",
      expression,
      time: normalizeTime(`${weekdaysMatch[2]}:${weekdaysMatch[1]}`),
    };
  }

  const weeklyMatch = expression.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+([0-6])$/);
  if (weeklyMatch) {
    return {
      ...base,
      mode: "weekly",
      expression,
      time: normalizeTime(`${weeklyMatch[2]}:${weeklyMatch[1]}`),
      weekday: weeklyMatch[3],
    };
  }

  const monthlyMatch = expression.match(/^(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+\*\s+\*$/);
  if (monthlyMatch) {
    return {
      ...base,
      mode: "monthly",
      expression,
      time: normalizeTime(`${monthlyMatch[2]}:${monthlyMatch[1]}`),
      dayOfMonth: normalizePositiveInteger(Number(monthlyMatch[3]), 1, 31),
    };
  }

  const dailyMatch = expression.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
  if (dailyMatch) {
    return {
      ...base,
      mode: "daily",
      expression,
      time: normalizeTime(`${dailyMatch[2]}:${dailyMatch[1]}`),
    };
  }

  return {
    ...base,
    mode: "custom",
    expression,
    customExpression: expression,
  };
}

export function switchCronScheduleMode(
  schedule: string,
  mode: CronScheduleMode,
): CronScheduleBuilder {
  const current = parseCronScheduleBuilder(schedule);
  const next = {
    ...createDefaultBuilder(),
    ...current,
    mode,
    customExpression:
      current.mode === "custom"
        ? current.customExpression || current.expression
        : current.expression,
  };
  next.expression = buildCronScheduleExpression(next);
  return next;
}

function pluralize(count: number, singular: string, plural: string) {
  return count > 1 ? plural : singular;
}

export function describeCronScheduleHuman(schedule: string) {
  const builder = parseCronScheduleBuilder(schedule);
  switch (builder.mode) {
    case "none":
      return "Aucune recurrence definie.";
    case "every":
      return `Toutes les ${builder.interval} ${pluralize(builder.interval, builder.unit === "minutes" ? "minute" : "heure", builder.unit === "minutes" ? "minutes" : "heures")}.`;
    case "daily":
      return `Chaque jour a ${builder.time}.`;
    case "weekdays":
      return `Du lundi au vendredi a ${builder.time}.`;
    case "weekly": {
      const weekday =
        CRON_WEEKDAY_OPTIONS.find((option) => option.value === builder.weekday)?.label || "Lundi";
      return `Chaque ${weekday.toLowerCase()} a ${builder.time}.`;
    }
    case "monthly":
      return `Chaque mois, le ${builder.dayOfMonth}, a ${builder.time}.`;
    case "custom":
      return builder.expression
        ? `Expression libre: ${builder.expression}`
        : "Expression libre vide.";
    default:
      return "Aucune recurrence definie.";
  }
}
