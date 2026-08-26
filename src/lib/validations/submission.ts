import { z } from "zod";
import { dateString, moneyAmount, optionalText, uuid } from "./shared";

export const submissionSchema = z.object({
  collector_id: uuid,
  amount: moneyAmount,
  submission_date: dateString.optional(),
  notes: optionalText(300),
});

export type SubmissionInput = z.input<typeof submissionSchema>;
export type SubmissionValues = z.output<typeof submissionSchema>;
