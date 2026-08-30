import type { Metadata } from "next";
import { UserCog } from "lucide-react";
import { Card, PageHeader } from "@/components/ui/card";
import { Badge, RoleBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  MobileCard,
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui/table";
import {
  AddUserButton,
  DeleteUserButton,
  EditUserButton,
  ResetPasswordButton,
} from "@/components/users/user-dialogs";
import { listUsers } from "@/lib/queries/reports";
import { requireAdmin } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  const [ctx, users] = await Promise.all([requireAdmin(), listUsers()]);

  return (
    <>
      <PageHeader
        title={t.users.title}
        description="Who can sign in, and what they are allowed to do."
        action={<AddUserButton />}
      />

      <Card className="overflow-hidden">
        {users.length === 0 ? (
          <EmptyState icon={UserCog} title={t.users.empty} action={<AddUserButton />} />
        ) : (
          <>
            {/* Mobile */}
            <div className="sm:hidden">
              {users.map((user) => (
                <MobileCard key={user.id}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
                        <span className="truncate">{user.full_name}</span>
                        {user.id === ctx.userId && <Badge tone="brand">{t.users.selfBadge}</Badge>}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-ink-soft">{user.email}</p>
                      {user.phone && <p className="text-xs text-ink-faint">{user.phone}</p>}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <RoleBadge role={user.role} />
                      {!user.is_active && <Badge tone="danger">{t.users.inactive}</Badge>}
                    </div>
                  </div>
                  <div className="mt-2.5 flex items-center gap-2">
                    <EditUserButton user={user} isSelf={user.id === ctx.userId} />
                    <ResetPasswordButton user={user} />
                    <DeleteUserButton user={user} isSelf={user.id === ctx.userId} />
                  </div>
                </MobileCard>
              ))}
            </div>

            {/* Desktop */}
            <TableWrap className="hidden sm:block">
              <Table>
                <THead>
                  <TR>
                    <TH>{t.users.fullName}</TH>
                    <TH>{t.auth.email}</TH>
                    <TH>{t.client.phone}</TH>
                    <TH>{t.users.role}</TH>
                    <TH>{t.client.status}</TH>
                    <TH>Joined</TH>
                    <TH align="right">{t.common.actions}</TH>
                  </TR>
                </THead>
                <TBody>
                  {users.map((user) => (
                    <TR key={user.id}>
                      <TD>
                        <span className="flex items-center gap-2 font-medium">
                          {user.full_name}
                          {user.id === ctx.userId && (
                            <Badge tone="brand">{t.users.selfBadge}</Badge>
                          )}
                        </span>
                      </TD>
                      <TD className="text-ink-soft">{user.email ?? "-"}</TD>
                      <TD className="text-ink-soft">{user.phone ?? "-"}</TD>
                      <TD>
                        <RoleBadge role={user.role} />
                      </TD>
                      <TD>
                        <Badge tone={user.is_active ? "positive" : "danger"}>
                          {user.is_active ? t.users.active : t.users.inactive}
                        </Badge>
                      </TD>
                      <TD className="whitespace-nowrap text-ink-soft">
                        {formatDate(user.created_at.slice(0, 10))}
                      </TD>
                      <TD align="right">
                        <div className="flex items-center justify-end gap-1.5">
                          <EditUserButton user={user} isSelf={user.id === ctx.userId} />
                          <ResetPasswordButton user={user} />
                          <DeleteUserButton user={user} isSelf={user.id === ctx.userId} />
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          </>
        )}
      </Card>

      <p className="mt-3 px-1 text-xs text-ink-faint">
        Deactivating stops someone signing in while keeping their name on every payment they
        collected - that is the right choice for anyone who has handled money. Deleting removes the
        account for good and is only possible when it has no financial history. Adding and deleting
        both ask for your own password first.
      </p>
    </>
  );
}
