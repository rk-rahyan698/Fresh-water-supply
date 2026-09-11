/**
 * Hand-maintained mirror of supabase/migrations/*.sql.
 *
 * Keep this in sync when you change the schema, or regenerate it with:
 *   npx supabase gen types typescript --project-id <ref> > src/types/database.ts
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type UserRole = "admin" | "collector";
export type ClientStatus = "active" | "inactive";
export type BillStatus = "unpaid" | "partial" | "paid";
export type PaymentMethod = "cash" | "bank" | "mobile_banking" | "other";
export type AdjustmentType = "discount" | "waiver" | "special_reduction" | "other";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          full_name: string;
          phone: string | null;
          email: string | null;
          role: UserRole;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          full_name: string;
          phone?: string | null;
          email?: string | null;
          role?: UserRole;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          full_name?: string;
          phone?: string | null;
          email?: string | null;
          role?: UserRole;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      areas: {
        Row: {
          id: string;
          name: string;
          description: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: { id?: string; name: string; description?: string | null; is_active?: boolean };
        Update: { name?: string; description?: string | null; is_active?: boolean };
        Relationships: [];
      };
      client_rate_history: {
        Row: {
          id: string;
          client_id: string;
          monthly_bill: number;
          effective_from: string;
          reason: string | null;
          changed_by: string | null;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "client_rate_history_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_rate_history_changed_by_fkey";
            columns: ["changed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      clients: {
        Row: {
          id: string;
          client_code: string;
          name: string;
          phone: string | null;
          address: string | null;
          start_date: string;
          status: ClientStatus;
          notes: string | null;
          area_id: string | null;
          created_at: string;
          updated_at: string;
          search_text: string;
        };
        Insert: {
          id?: string;
          client_code: string;
          name: string;
          phone?: string | null;
          address?: string | null;
          start_date?: string;
          status?: ClientStatus;
          notes?: string | null;
          area_id?: string | null;
        };
        Update: {
          client_code?: string;
          name?: string;
          phone?: string | null;
          address?: string | null;
          start_date?: string;
          status?: ClientStatus;
          notes?: string | null;
          area_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "clients_area_id_fkey";
            columns: ["area_id"];
            isOneToOne: false;
            referencedRelation: "areas";
            referencedColumns: ["id"];
          },
        ];
      };
      monthly_bills: {
        Row: {
          id: string;
          client_id: string;
          billing_month: string;
          /** The ORIGINAL amount billed, before any adjustment. */
          bill_amount: number;
          /** Admin-approved discount / waiver. Reduces what the client owes. */
          adjustment_amount: number;
          adjustment_type: AdjustmentType | null;
          adjustment_reason: string | null;
          adjusted_by: string | null;
          adjusted_at: string | null;
          /** bill_amount - adjustment_amount. The amount actually payable. */
          adjusted_amount: number;
          paid_amount: number;
          /** adjusted_amount - paid_amount. */
          due_amount: number;
          status: BillStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          client_id: string;
          billing_month: string;
          bill_amount: number;
        };
        Update: {
          bill_amount?: number;
        };
        Relationships: [
          {
            foreignKeyName: "monthly_bills_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "monthly_bills_adjusted_by_fkey";
            columns: ["adjusted_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      payments: {
        Row: {
          id: string;
          receipt_no: number;
          monthly_bill_id: string;
          amount: number;
          payment_date: string;
          payment_method: PaymentMethod;
          collected_by: string;
          notes: string | null;
          voided_at: string | null;
          voided_by: string | null;
          void_reason: string | null;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "payments_monthly_bill_id_fkey";
            columns: ["monthly_bill_id"];
            isOneToOne: false;
            referencedRelation: "monthly_bills";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "payments_collected_by_fkey";
            columns: ["collected_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "payments_voided_by_fkey";
            columns: ["voided_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      cash_submissions: {
        Row: {
          id: string;
          collector_id: string;
          submission_date: string;
          amount: number;
          received_by: string;
          notes: string | null;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "cash_submissions_collector_id_fkey";
            columns: ["collector_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "cash_submissions_received_by_fkey";
            columns: ["received_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_logs: {
        Row: {
          id: string;
          user_id: string | null;
          action: string;
          entity_type: string;
          entity_id: string | null;
          old_data: Json | null;
          new_data: Json | null;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "audit_logs_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<never, never>;
    Functions: {
      record_payment: {
        Args: {
          p_client_id: string;
          p_billing_month: string;
          p_amount: number;
          p_payment_method?: PaymentMethod;
          p_notes?: string | null;
          p_payment_date?: string | null;
        };
        Returns: Database["public"]["Tables"]["payments"]["Row"];
      };
      void_payment: {
        Args: { p_payment_id: string; p_reason: string };
        Returns: Database["public"]["Tables"]["payments"]["Row"];
      };
      generate_monthly_bills: {
        Args: { p_billing_month: string };
        Returns: { created_count: number; skipped_count: number; billed_amount: number }[];
      };
      generate_client_bill: {
        Args: { p_client_id: string; p_billing_month: string };
        Returns: Database["public"]["Tables"]["monthly_bills"]["Row"];
      };
      set_bill_adjustment: {
        Args: {
          p_bill_id: string;
          p_adjustment_amount: number;
          p_adjustment_type: AdjustmentType | null;
          p_adjustment_reason: string | null;
        };
        Returns: Database["public"]["Tables"]["monthly_bills"]["Row"];
      };
      remove_bill_adjustment: {
        Args: { p_bill_id: string };
        Returns: Database["public"]["Tables"]["monthly_bills"]["Row"];
      };
      update_bill_amount: {
        Args: { p_bill_id: string; p_bill_amount: number };
        Returns: Database["public"]["Tables"]["monthly_bills"]["Row"];
      };
      create_cash_submission: {
        Args: {
          p_collector_id: string;
          p_amount: number;
          p_submission_date?: string | null;
          p_notes?: string | null;
        };
        Returns: Database["public"]["Tables"]["cash_submissions"]["Row"];
      };
      collector_stats: {
        Args: { p_collector_id: string; p_month?: string | null };
        Returns: Json;
      };
      dashboard_summary: {
        Args: { p_month?: string | null; p_area_id?: string | null };
        Returns: Json;
      };
      monthly_series: {
        Args: { p_months?: number; p_area_id?: string | null };
        Returns: {
          billing_month: string;
          original_amount: number;
          adjustment_amount: number;
          /** The ADJUSTED total, so collected + due always equals it. */
          billed_amount: number;
          collected_amount: number;
          due_amount: number;
        }[];
      };
      collector_series: {
        Args: { p_from?: string | null; p_to?: string | null; p_area_id?: string | null };
        Returns: {
          collector_id: string;
          collector_name: string;
          payments_count: number;
          total_amount: number;
          cash_amount: number;
        }[];
      };
      daily_collection_report: {
        Args: { p_date?: string | null; p_area_id?: string | null };
        Returns: {
          collector_id: string;
          collector_name: string;
          payments_count: number;
          total_amount: number;
        }[];
      };
      collector_daily_breakdown: {
        Args: { p_collector_id: string; p_from: string; p_to: string };
        Returns: {
          collection_date: string;
          payments_count: number;
          total_amount: number;
        }[];
      };
      update_own_profile: {
        Args: { p_full_name: string; p_phone?: string | null };
        Returns: Database["public"]["Tables"]["profiles"]["Row"];
      };
      admin_update_profile: {
        Args: {
          p_user_id: string;
          p_full_name: string;
          p_phone: string | null;
          p_role: UserRole;
          p_is_active: boolean;
        };
        Returns: Database["public"]["Tables"]["profiles"]["Row"];
      };
      upsert_client: {
        Args: {
          p_id: string | null;
          p_client_code: string;
          p_name: string;
          p_phone: string | null;
          p_address: string | null;
          p_monthly_bill: number;
          p_start_date: string | null;
          p_status: ClientStatus;
          p_notes: string | null;
          p_area_id?: string | null;
        };
        Returns: Database["public"]["Tables"]["clients"]["Row"];
      };
      set_client_status: {
        Args: { p_client_id: string; p_status: ClientStatus };
        Returns: Database["public"]["Tables"]["clients"]["Row"];
      };
      delete_client: {
        Args: { p_client_id: string };
        Returns: undefined;
      };
      upsert_area: {
        Args: {
          p_id: string | null;
          p_name: string;
          p_description?: string | null;
          p_is_active?: boolean;
        };
        Returns: Database["public"]["Tables"]["areas"]["Row"];
      };
      delete_area: { Args: { p_area_id: string }; Returns: undefined };
      set_client_area: {
        Args: { p_client_id: string; p_area_id: string | null };
        Returns: Database["public"]["Tables"]["clients"]["Row"];
      };
      set_client_rate: {
        Args: {
          p_client_id: string;
          p_monthly_bill: number;
          p_effective_from: string;
          p_reason?: string | null;
        };
        Returns: Database["public"]["Tables"]["client_rate_history"]["Row"];
      };
      client_rate_for_month: {
        Args: { p_client_id: string; p_billing_month: string };
        Returns: number;
      };
      client_current_rate: {
        Args: { p_client_id: string };
        Returns: number;
      };
      client_bill_years: {
        Args: { p_client_id: string };
        Returns: { bill_year: number; bill_count: number }[];
      };
      client_bill_matrix: {
        Args: { p_client_id: string; p_from_year?: number | null; p_to_year?: number | null };
        Returns: {
          bill_id: string;
          billing_month: string;
          bill_year: number;
          bill_month: number;
          bill_amount: number;
          adjustment_amount: number;
          adjusted_amount: number;
          paid_amount: number;
          due_amount: number;
          status: BillStatus;
          adjustment_type: AdjustmentType | null;
          adjustment_reason: string | null;
          payment_count: number;
        }[];
      };
      area_summary: {
        Args: { p_month?: string | null };
        Returns: {
          area_id: string | null;
          area_name: string;
          is_active: boolean;
          client_count: number;
          original_amount: number;
          adjustment_amount: number;
          adjusted_amount: number;
          collected_amount: number;
          due_amount: number;
          paid_count: number;
          partial_count: number;
          unpaid_count: number;
        }[];
      };
      client_month_overview: {
        Args: {
          p_month?: string | null;
          p_area_id?: string | null;
          p_search?: string | null;
          p_status?: ClientStatus | null;
          p_limit?: number;
          p_offset?: number;
        };
        Returns: {
          client_id: string;
          client_code: string;
          name: string;
          phone: string | null;
          address: string | null;
          area_id: string | null;
          area_name: string | null;
          monthly_bill: number;
          client_status: ClientStatus;
          bill_id: string | null;
          bill_amount: number | null;
          adjustment_amount: number | null;
          adjusted_amount: number | null;
          paid_amount: number | null;
          due_amount: number | null;
          bill_status: BillStatus | null;
          total_count: number;
        }[];
      };
      payment_years: {
        Args: Record<string, never>;
        Returns: { payment_year: number; payment_count: number; total_amount: number }[];
      };
      collection_matrix: {
        Args: { p_year: number; p_area_id?: string | null; p_collector_id?: string | null };
        Returns: {
          client_id: string;
          client_code: string;
          client_name: string;
          area_id: string | null;
          area_name: string | null;
          m01: number; m02: number; m03: number; m04: number; m05: number; m06: number;
          m07: number; m08: number; m09: number; m10: number; m11: number; m12: number;
          year_total: number;
          payment_count: number;
        }[];
      };
      collection_summary: {
        Args: { p_year: number; p_area_id?: string | null; p_collector_id?: string | null };
        Returns: Json;
      };
      /**
       * Aggregates for the collections list. SECURITY INVOKER, so RLS scopes a
       * collector to their own payments. See migration 0009.
       */
      payment_totals: {
        Args: {
          p_from?: string | null;
          p_to?: string | null;
          p_billing_month?: string | null;
          p_collector_id?: string | null;
          p_client_id?: string | null;
          p_area_id?: string | null;
          p_method?: PaymentMethod | null;
          p_search?: string | null;
          p_include_voided?: boolean;
        };
        Returns: Json;
      };
      bill_totals: {
        Args: {
          p_billing_month: string;
          p_status?: BillStatus | null;
          p_area_id?: string | null;
          p_search?: string | null;
        };
        Returns: Json;
      };
      due_totals: {
        Args: {
          p_billing_month?: string | null;
          p_area_id?: string | null;
          p_min_due?: number | null;
          p_search?: string | null;
        };
        Returns: Json;
      };
      /**
       * One amount across several of a client's bills, atomically - one
       * payment row per bill. See migration 0010.
       */
      record_collection: {
        Args: {
          p_client_id: string;
          /** `[{ billing_month: "YYYY-MM-01", amount: 1000 }, ...]` */
          p_allocations: Json;
          p_payment_method?: PaymentMethod;
          p_notes?: string | null;
          p_payment_date?: string | null;
        };
        Returns: Database["public"]["Tables"]["payments"]["Row"][];
      };
      collection_receipt: {
        Args: { p_payment_id: string };
        Returns: {
          payment_id: string;
          receipt_no: number;
          billing_month: string;
          bill_amount: number;
          adjustment_amount: number;
          adjusted_amount: number;
          previously_paid: number;
          amount: number;
          remaining_due: number;
          voided: boolean;
          void_reason: string | null;
        }[];
      };
      collection_bill_months: {
        Args: { p_year: number; p_area_id?: string | null };
        /** bill_amounts: 12 entries, January first, null where not billed. */
        Returns: { client_id: string; bill_amounts: (number | null)[] }[];
      };
      change_client_rate: {
        Args: {
          p_client_id: string;
          p_monthly_bill: number;
          p_effective_from: string;
          p_reason?: string | null;
          p_update_current_bill?: boolean;
        };
        Returns: Json;
      };
      client_payment_history: {
        Args: { p_client_id: string; p_year?: number | null; p_limit?: number };
        Returns: {
          payment_id: string;
          receipt_no: number;
          billing_month: string;
          payment_date: string;
          amount: number;
          payment_method: PaymentMethod;
          collector_name: string | null;
          notes: string | null;
          voided: boolean;
          void_reason: string | null;
        }[];
      };
      client_financial_summary: {
        Args: { p_client_id: string; p_year?: number | null };
        Returns: Json;
      };
      is_admin: { Args: Record<string, never>; Returns: boolean };
      is_active_user: { Args: Record<string, never>; Returns: boolean };
      current_user_role: { Args: Record<string, never>; Returns: UserRole };
      dhaka_today: { Args: Record<string, never>; Returns: string };
      dhaka_current_month: { Args: Record<string, never>; Returns: string };
    };
    Enums: {
      user_role: UserRole;
      client_status: ClientStatus;
      bill_status: BillStatus;
      payment_method: PaymentMethod;
      adjustment_type: AdjustmentType;
    };
    CompositeTypes: Record<never, never>;
  };
}

/* -------------------------------------------------------------------------- */
/* Convenience aliases used across the app                                     */
/* -------------------------------------------------------------------------- */

type Tables = Database["public"]["Tables"];

export type Profile = Tables["profiles"]["Row"];
export type Area = Tables["areas"]["Row"];
export type ClientRate = Tables["client_rate_history"]["Row"];
export type Client = Tables["clients"]["Row"];
export type MonthlyBill = Tables["monthly_bills"]["Row"];
export type Payment = Tables["payments"]["Row"];
export type CashSubmission = Tables["cash_submissions"]["Row"];
export type AuditLog = Tables["audit_logs"]["Row"];

/**
 * A client plus the rate in force this month.
 *
 * `monthly_bill` is no longer a column - it is derived from
 * client_rate_history and served by a PostgREST computed field of the same
 * name, so it has to be asked for explicitly: `.select("*, monthly_bill")`.
 * Anything that only does `.select("*")` gets a plain `Client` and, correctly,
 * no rate.
 */
export type ClientWithRate = Client & {
  monthly_bill: number;
};

/** A client joined with its area, plus this month's rate. */
export type ClientWithArea = ClientWithRate & {
  areas: Pick<Area, "id" | "name"> | null;
};

/** A bill joined with the client it belongs to. */
export type BillWithClient = MonthlyBill & {
  clients:
    | (Pick<Client, "id" | "name" | "client_code" | "phone" | "address" | "area_id"> & {
        areas: { name: string } | null;
      })
    | null;
};

/** A payment joined with everything the collections table needs to show. */
export type PaymentDetail = Payment & {
  clients: Pick<Client, "id" | "name" | "client_code"> | null;
  monthly_bills: Pick<MonthlyBill, "id" | "billing_month" | "bill_amount"> | null;
  collector: Pick<Profile, "id" | "full_name"> | null;
};

export type SubmissionDetail = CashSubmission & {
  collector: Pick<Profile, "id" | "full_name"> | null;
  receiver: Pick<Profile, "id" | "full_name"> | null;
};

/** Shape returned by the collector_stats() RPC. */
export interface CollectorStats {
  collector_id: string;
  today_collection: number;
  today_count: number;
  month_collection: number;
  month_count: number;
  total_collection: number;
  total_count: number;
  cash_collection: number;
  total_submitted: number;
  unsubmitted: number;
}

/** Shape returned by the dashboard_summary() RPC. */
export interface DashboardSummary {
  billing_month: string;
  today: string;
  active_clients: number;
  inactive_clients: number;
  total_outstanding: number;
  unsubmitted_cash: number;
  /** Sum of bill_amount before adjustments. */
  original_amount: number;
  /** Sum of admin-approved discounts / waivers. */
  adjustment_amount: number;
  /** Sum of adjusted_amount: collected + due always equals this. */
  billed_amount: number;
  collected_amount: number;
  due_amount: number;
  bill_count: number;
  adjusted_count: number;
  unpaid_count: number;
  partial_count: number;
  paid_count: number;
  received_in_month: number;
  received_today: number;
  payments_today: number;
  payments_in_month: number;
}

/** Shape returned by the collection_summary() RPC. */
export interface CollectionSummary {
  year: number;
  area_id: string | null;
  collector_id: string | null;
  client_count: number;
  /** Payment-date basis. */
  total_collected: number;
  payment_count: number;
  paying_clients: number;
  average_payment: number;
  /** Billing-month basis. */
  original_amount: number;
  adjustment_amount: number;
  adjusted_amount: number;
  billed_collected: number;
  outstanding: number;
  bill_count: number;
}

/** Shape returned by the client_financial_summary() RPC. */
export interface ClientFinancialSummary {
  year: number | null;
  paid_in_period: number;
  original_amount: number;
  adjustment_amount: number;
  adjusted_amount: number;
  collected_amount: number;
  outstanding: number;
  bill_count: number;
}

/** Shape returned by the payment_totals() RPC (migration 0009). */
export interface PaymentTotals {
  total_amount: number;
  payment_count: number;
}

/** Shape returned by the bill_totals() RPC (migration 0009). */
export interface BillTotalsRow {
  original_amount: number;
  adjustment_amount: number;
  adjusted_amount: number;
  paid_amount: number;
  due_amount: number;
  bill_count: number;
}

/**
 * Shape returned by the due_totals() RPC (migration 0009).
 *
 * Describes the whole filtered set, not the row list the Due Report shows -
 * that stays capped.
 */
export interface DueTotals {
  total_due: number;
  bill_count: number;
  /** Distinct clients, not bills: eight unpaid months is still one client. */
  client_count: number;
}
