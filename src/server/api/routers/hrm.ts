import { z } from 'zod';
import { authedProcedure, permissionProcedure, readTx, router, tx } from '@/server/api/trpc';
import * as employee from '@/server/modules/hrm/employee';
import * as organization from '@/server/modules/hrm/organization';
import * as attendance from '@/server/modules/hrm/attendance';
import * as leave from '@/server/modules/hrm/leave';
import { nextDocNo } from '@/server/modules/numbering/service';
import { cuid, dateString, paging, requestId, skipTake } from '@/server/api/schemas/common';

const attendanceStatus = z.enum([
  'NORMAL',
  'LATE',
  'EARLY_LEAVE',
  'ABSENT',
  'LEAVE',
  'HALF_LEAVE',
  'HOLIDAY',
  'BUSINESS_TRIP',
]);

const employeeInput = z.object({
  employeeNo: z.string().max(20).optional(),
  name: z.string().min(1).max(50),
  birthDate: dateString.optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().max(100).optional(),
  address: z.string().max(200).optional(),
  hireDate: dateString,
  departmentId: cuid.optional(),
  positionCode: z.string().max(30).optional(),
  jobTitle: z.string().max(50).optional(),
  employmentType: z.enum(['REGULAR', 'CONTRACT', 'PARTTIME', 'INTERN']).optional(),
  contractEndDate: dateString.optional(),
});

export const hrmRouter = router({
  // ── HRM-01 employees ──
  list: permissionProcedure('hr.self')
    .input(
      paging.extend({
        q: z.string().trim().optional(),
        departmentId: cuid.optional(),
        status: z.string().optional(),
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => {
        const { rows, total } = await employee.list(t, {
          ...(input.q ? { q: input.q } : {}),
          ...(input.departmentId ? { departmentId: input.departmentId } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...skipTake(input),
        });
        return { rows, total, page: input.page, pageSize: input.pageSize };
      }),
    ),

  detail: permissionProcedure('hr.self')
    .input(z.object({ id: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => employee.detail(t, input.id))),

  me: authedProcedure.query(({ ctx }) => readTx(ctx, (t) => employee.me(t))),

  create: permissionProcedure('hr.write')
    .input(employeeInput.extend({ requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          const { requestId: _rid, ...data } = input;
          return employee.create(t, data);
        },
        input.requestId,
      ),
    ),

  update: permissionProcedure('hr.write')
    .input(employeeInput.partial().extend({ id: cuid, version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          const { id, version, requestId: _rid, ...data } = input;
          return employee.update(t, id, data, version);
        },
        input.requestId,
      ),
    ),

  resign: permissionProcedure('hr.write')
    .input(
      z.object({
        employeeId: cuid,
        leaveDate: dateString,
        reason: z.string().max(200).optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          await employee.resign(t, {
            employeeId: input.employeeId,
            leaveDate: input.leaveDate,
            ...(input.reason ? { reason: input.reason } : {}),
          });
          return { ok: true };
        },
        input.requestId,
      ),
    ),

  overview: permissionProcedure('hr.read')
    .input(z.object({ asOf: dateString.optional() }))
    .query(({ ctx, input }) => readTx(ctx, (t) => employee.overview(t, input.asOf))),

  // ── HRM-12 sensitive data ──
  setSensitive: permissionProcedure('hr.sensitive.read')
    .input(
      z.object({
        employeeId: cuid,
        residentNo: z.string().max(20).optional(),
        bankName: z.string().max(50).optional(),
        bankAccount: z.string().max(40).optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          const { requestId: _rid, ...data } = input;
          await employee.setSensitive(t, data);
          return { ok: true };
        },
        input.requestId,
      ),
    ),

  revealSensitive: permissionProcedure('hr.sensitive.read')
    .input(
      z.object({
        employeeId: cuid,
        field: z.enum(['residentNo', 'bankAccount']),
        reason: z.string().min(5).max(200),
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(ctx, async (t) => ({ value: await employee.revealSensitive(t, input) })),
    ),

  sensitiveAccessLog: permissionProcedure('hr.sensitive.read')
    .input(z.object({ employeeId: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => employee.sensitiveAccessLog(t, input.employeeId))),

  // ── HRM-13 self service ──
  requestChange: authedProcedure
    .input(
      z.object({
        changes: z.record(z.string(), z.object({ before: z.string().nullable(), after: z.string() })),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(ctx, (t) => employee.requestChange(t, { changes: input.changes }), input.requestId),
    ),

  reviewChange: permissionProcedure('hr.write')
    .input(
      z.object({
        requestId: cuid,
        approve: z.boolean(),
        note: z.string().max(200).optional(),
        idempotencyKey: requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          await employee.reviewChange(t, {
            requestId: input.requestId,
            approve: input.approve,
            ...(input.note ? { note: input.note } : {}),
          });
          return { ok: true };
        },
        input.idempotencyKey,
      ),
    ),

  // ── HRM-02 / HRM-03 organisation ──
  orgChart: permissionProcedure('hr.self')
    .input(z.object({ asOf: dateString.optional() }))
    .query(({ ctx, input }) => readTx(ctx, (t) => organization.chart(t, input.asOf))),

  createDepartment: permissionProcedure('hr.write')
    .input(
      z.object({
        code: z.string().min(1).max(20),
        name: z.string().min(1).max(50),
        parentId: cuid.optional(),
        headEmployeeId: cuid.optional(),
        validFrom: dateString,
        sortOrder: z.number().int().optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          const { requestId: _rid, ...data } = input;
          return organization.createDepartment(t, data);
        },
        input.requestId,
      ),
    ),

  reorganize: permissionProcedure('hr.write')
    .input(
      z.object({
        departmentId: cuid,
        effectiveDate: dateString,
        name: z.string().max(50).optional(),
        parentId: cuid.nullable().optional(),
        headEmployeeId: cuid.nullable().optional(),
        close: z.boolean().optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          const { requestId: _rid, ...data } = input;
          await organization.reorganize(t, data);
          return { ok: true };
        },
        input.requestId,
      ),
    ),

  departmentHistory: permissionProcedure('hr.read')
    .input(z.object({ departmentId: cuid.optional() }))
    .query(({ ctx, input }) => readTx(ctx, (t) => organization.departmentHistory(t, input.departmentId))),

  assign: permissionProcedure('hr.write')
    .input(
      z.object({
        employeeId: cuid,
        type: z.enum(['HIRE', 'PROMOTION', 'TRANSFER', 'LEAVE_OF_ABSENCE', 'RETURN', 'RESIGN']),
        effectiveFrom: dateString,
        departmentId: cuid.optional(),
        positionCode: z.string().max(30).optional(),
        jobTitle: z.string().max(50).optional(),
        employmentType: z.string().max(20).optional(),
        note: z.string().max(200).optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          const { requestId: _rid, ...data } = input;
          return organization.assign(t, data);
        },
        input.requestId,
      ),
    ),

  assignmentHistory: permissionProcedure('hr.self')
    .input(z.object({ employeeId: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => organization.assignmentHistory(t, input.employeeId))),

  positionAt: permissionProcedure('hr.self')
    .input(z.object({ employeeId: cuid, asOf: dateString }))
    .query(({ ctx, input }) => readTx(ctx, (t) => organization.positionAt(t, input.employeeId, input.asOf))),

  // ── HRM-04 / HRM-07 attendance ──
  checkIn: authedProcedure
    .input(z.object({ requestId }))
    .mutation(({ ctx, input }) => tx(ctx, (t) => attendance.checkIn(t, {}), input.requestId)),

  checkOut: authedProcedure
    .input(z.object({ breakMinutes: z.number().int().min(0).max(480).optional(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) =>
          attendance.checkOut(
            t,
            input.breakMinutes !== undefined ? { breakMinutes: input.breakMinutes } : {},
          ),
        input.requestId,
      ),
    ),

  attendanceMonthly: permissionProcedure('hr.self')
    .input(z.object({ employeeId: cuid, from: dateString, to: dateString }))
    .query(({ ctx, input }) => readTx(ctx, (t) => attendance.monthly(t, input))),

  attendanceUpload: permissionProcedure('hr.attendance')
    .input(
      z.object({
        rows: z
          .array(
            z.object({
              employeeNo: z.string(),
              workDate: z.string(),
              checkIn: z.string().optional(),
              checkOut: z.string().optional(),
              status: attendanceStatus.optional(),
              note: z.string().optional(),
            }),
          )
          .min(1)
          .max(2000),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) => tx(ctx, (t) => attendance.bulkUpload(t, input.rows), input.requestId)),

  requestCorrection: authedProcedure
    .input(
      z.object({
        workDate: dateString,
        requestedCheckIn: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .optional(),
        requestedCheckOut: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .optional(),
        requestedStatus: attendanceStatus.optional(),
        reason: z.string().min(5).max(200),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          const docNo = await nextDocNo(t, 'ATTENDANCE_CORRECTION', input.workDate);
          const { requestId: _rid, ...data } = input;
          return attendance.requestCorrection(t, { docNo, ...data });
        },
        input.requestId,
      ),
    ),

  listCorrections: permissionProcedure('hr.self')
    .input(paging.extend({ employeeId: cuid.optional(), status: z.string().optional() }))
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => {
        const { rows, total } = await attendance.listCorrections(t, {
          ...(input.employeeId ? { employeeId: input.employeeId } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...skipTake(input),
        });
        return { rows, total, page: input.page, pageSize: input.pageSize };
      }),
    ),

  // ── HRM-05 / HRM-06 leave ──
  leaveBalance: permissionProcedure('hr.self')
    .input(
      z.object({ employeeId: cuid, asOf: dateString.optional(), leaveType: z.string().default('ANNUAL') }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, (t) => leave.balanceOf(t, input.employeeId, input.asOf, input.leaveType)),
    ),

  grantAnnual: permissionProcedure('hr.leave')
    .input(z.object({ employeeId: cuid, asOf: dateString.optional(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) =>
          leave.grantAnnual(t, {
            employeeId: input.employeeId,
            ...(input.asOf ? { asOf: input.asOf } : {}),
          }),
        input.requestId,
      ),
    ),

  grantManual: permissionProcedure('hr.leave')
    .input(
      z.object({
        employeeId: cuid,
        leaveType: z.string().max(20).optional(),
        days: z.string().regex(/^\d+(\.\d)?$/),
        grantDate: dateString,
        expiresAt: dateString,
        reason: z.string().min(2).max(200),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          const { requestId: _rid, ...data } = input;
          return leave.grantManual(t, data);
        },
        input.requestId,
      ),
    ),

  requestLeave: authedProcedure
    .input(
      z.object({
        leaveType: z.string().max(20).optional(),
        startDate: dateString,
        endDate: dateString,
        halfDay: z.enum(['AM', 'PM']).optional(),
        reason: z.string().max(200).optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          const docNo = await nextDocNo(t, 'LEAVE_REQUEST', input.startDate);
          const { requestId: _rid, ...data } = input;
          return leave.requestLeave(t, { docNo, ...data });
        },
        input.requestId,
      ),
    ),

  listLeaveRequests: permissionProcedure('hr.self')
    .input(
      paging.extend({
        employeeId: cuid.optional(),
        status: z.string().optional(),
        from: dateString.optional(),
        to: dateString.optional(),
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => {
        const { rows, total } = await leave.listRequests(t, {
          ...(input.employeeId ? { employeeId: input.employeeId } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.from ? { from: input.from } : {}),
          ...(input.to ? { to: input.to } : {}),
          ...skipTake(input),
        });
        return { rows, total, page: input.page, pageSize: input.pageSize };
      }),
    ),

  cancelLeave: permissionProcedure('hr.leave')
    .input(z.object({ leaveRequestId: cuid, reason: z.string().min(2).max(200), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          await leave.cancelApprovedLeave(t, input.leaveRequestId, input.reason);
          return { ok: true };
        },
        input.requestId,
      ),
    ),

  expireGrants: permissionProcedure('hr.leave')
    .input(z.object({ asOf: dateString.optional(), requestId }))
    .mutation(({ ctx, input }) => tx(ctx, (t) => leave.expireGrants(t, input.asOf), input.requestId)),

  leaveUsageSummary: permissionProcedure('hr.read')
    .input(z.object({ from: dateString, to: dateString }))
    .query(({ ctx, input }) => readTx(ctx, (t) => leave.usageSummary(t, input.from, input.to))),

  // ── HRM-09 certificates ──
  issueCertificate: permissionProcedure('hr.self')
    .input(
      z.object({
        employeeId: cuid,
        certType: z.enum(['EMPLOYMENT', 'CAREER']),
        purpose: z.string().max(100).optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          const issueNo = await nextDocNo(t, 'CERTIFICATE');
          return employee.issueCertificate(t, {
            employeeId: input.employeeId,
            certType: input.certType,
            ...(input.purpose ? { purpose: input.purpose } : {}),
            issueNo,
          });
        },
        input.requestId,
      ),
    ),

  certificateHistory: permissionProcedure('hr.self')
    .input(z.object({ employeeId: cuid.optional(), take: z.number().int().min(1).max(200).optional() }))
    .query(({ ctx, input }) =>
      tx(ctx, (t) =>
        employee.certificateHistory(t, {
          ...(input.employeeId ? { employeeId: input.employeeId } : {}),
          ...(input.take ? { take: input.take } : {}),
        }),
      ),
    ),

  pendingChangeRequests: permissionProcedure('hr.write')
    .input(z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING') }))
    .query(({ ctx, input }) => tx(ctx, (t) => employee.pendingChangeRequests(t, input.status))),
});
