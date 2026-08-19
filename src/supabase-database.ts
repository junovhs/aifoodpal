export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface DaybookRow {
  user_id: string;
  state: Json;
  revision: number;
  created_at: string;
  updated_at: string;
}

export type Database = {
  public: {
    Tables: {
      daybooks: {
        Row: DaybookRow;
        Insert: Omit<DaybookRow, "created_at" | "updated_at"> & { created_at?: string; updated_at?: string };
        Update: Partial<Omit<DaybookRow, "user_id" | "created_at">>;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: {
      save_daybook: {
        Args: { expected_revision: number; next_state: Json };
        Returns: DaybookRow;
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
