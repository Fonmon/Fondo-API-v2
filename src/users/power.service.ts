import { Injectable } from '@nestjs/common';
import { assertOwnership } from '../auth/policies/ownership';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { formatDateEs } from '../common/i18n/spanish-format';
import {
  buildPageEnvelope,
  isPageBeyondLast,
  pageOffset,
  type PageEnvelope,
} from '../common/http/pagination';
import { fromDateColumn } from '../common/utils/date.util';
import { plainDateToUtcDate } from '../common/utils/timezone.util';
import { EmailTemplate } from '../mail/email-template';
import { MailService } from '../mail/mail.service';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { serializePower, type PowerDto } from './dto/user.serializers';
import { asPythonDict, pyGet, toDjangoSmallInt, PythonTypeError } from './python-obj';
import { UserService } from './user.service';

/** `Power.POWER_STATE`. */
export const POWER_PENDING = 0;
export const POWER_APPROVED = 1;
export const POWER_REJECTED = 2;

/**
 * `fondo_api/services/user.py:handle_power_request` — powers of attorney for the annual
 * assembly. One member asks another to vote on their behalf; the requestee approves or
 * rejects; on approval the fund emails a formal Spanish letter.
 *
 * Split out of {@link UserService} for file size only. v1 has it as a fourth branch of the
 * same class, and the call graph is unchanged: it still reaches `get_profile` and
 * `get_users_attr` through `UserService`.
 *
 * ## The multiplexer is the API
 *
 * There is one route, `POST /api/user/power`, and the body's `type` selects the verb:
 *
 * ```python
 * if   request['type'].lower() == 'post':  ...create + notify, return None
 * elif request['type'].lower() == 'get':   ...paginate, return the envelope
 * elif request['type'].lower() == 'patch': ...set state, mail on approval, return None
 * ```
 *
 * ⚠️ **Every failure here is a 500**, because `UserAppsView.post` wraps the call in
 * `except Exception: return Response(status=500)`. A missing `type`, a missing `obj`, an
 * unknown power id, a page number below 1 — all 500. v1's own suite asserts one of them
 * (`test_get_powers_exception`). None of that is modernised.
 *
 * ⚠️ An unrecognised `type` falls off the end of the `elif` chain and returns `None`, i.e. a
 * **200 with a zero-byte body**. Also ported.
 *
 * ## Two deviations
 *
 * **D2 — approval is restricted to the requestee.** v1 does `Power.objects.get(id=request['id'])`
 * with no ownership check at all, so any authenticated member can approve any power request —
 * including one addressed to somebody else — and trigger the fund-wide email. Q17: restrict.
 *
 * **D5 — the letter goes out blind.** v1 puts every member's address in `ToAddresses` with an
 * empty `Bcc`, disclosing all 15 addresses to all 15 members on every approval. Q18: move them
 * to `Bcc`. The recipient list is unchanged (Q10: all members).
 */
@Injectable()
export class PowerService {
  private readonly ITEMS_PER_PAGE = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UserService,
    private readonly mail: MailService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * The multiplexer. Returns `undefined` where v1 returns `None`, which the controller
   * renders as a **zero-byte 200** (DRF's `JSONRenderer.render(None)` is `b''`).
   */
  async handlePowerRequest(
    actor: AuthenticatedUser,
    body: unknown,
  ): Promise<PageEnvelope<PowerDto> | undefined> {
    const request = asPythonDict(body);
    const type = pythonLower(pyGet(request, 'type'));

    if (type === 'post') {
      await this.createPower(actor, request);
      return undefined;
    }
    if (type === 'get') {
      return this.listPowers(actor, request);
    }
    if (type === 'patch') {
      await this.updatePower(actor, request);
      return undefined;
    }
    // v1's chain has no `else`: the function returns `None`.
    return undefined;
  }

  /**
   * ```python
   * Power.objects.create(meeting_date=request['meeting_date'],
   *                      requester=self.get_profile(user_id),
   *                      requestee=self.get_profile(request['requestee']))
   * self.__notification_service.send_notification([request['requestee']],
   *     'Te han enviado una solicitud para ser apoderado en una reunion. Revisala',
   *     '/tool/power')
   * ```
   *
   * `state` is the model default, `0` (PENDING). A non-existent requestee is
   * `UserProfile.DoesNotExist` → 500.
   *
   * The push notification is sent **after** the row is written and outside any transaction —
   * v1 has no `transaction.atomic()` here, and Phase 2's condition 3 forbids publishing from
   * inside one.
   */
  private async createPower(
    actor: AuthenticatedUser,
    request: Record<string, unknown>,
  ): Promise<void> {
    const requesteeId = toDjangoSmallInt(pyGet(request, 'requestee'), 'requestee');
    const meetingDate = parseDateField(pyGet(request, 'meeting_date'), 'meeting_date');

    // `self.get_profile(...)` on both sides; a miss is `DoesNotExist` -> 500.
    const requester = await this.users.getProfile(actor.id);
    const requestee = await this.users.getProfile(requesteeId);
    if (requester === null || requestee === null) {
      throw new PythonTypeError('UserProfile matching query does not exist.');
    }

    await this.prisma.power.create({
      data: {
        meeting_date: meetingDate,
        state: POWER_PENDING,
        requester_id: requester.user_ptr_id,
        requestee_id: requestee.user_ptr_id,
      },
    });

    await this.notifications.sendNotification(
      [requesteeId],
      'Te han enviado una solicitud para ser apoderado en una reunion. Revisala',
      '/tool/power',
    );
  }

  /**
   * ```python
   * objs = []
   * if request['obj'] == 'requested': objs = user.power_requested.all().order_by('-id')
   * if request['obj'] == 'requestee': objs = user.power_requestee.all().order_by('-id')
   * paginator = Paginator(objs, self.ITEMS_PER_PAGE)
   * ```
   *
   * ⚠️ The two related names read backwards: `power_requested` is the reverse of the
   * **requester** FK ("powers I asked for") and `power_requestee` the reverse of the
   * **requestee** FK ("powers I was asked to hold").
   *
   * ⚠️ An `obj` that is neither leaves `objs = []`, so the answer is the empty envelope with
   * `num_pages: 1` — not a 400. A **missing** `obj` key is a `KeyError` → 500, which is
   * exactly what `test_get_powers_exception` asserts.
   */
  private async listPowers(
    actor: AuthenticatedUser,
    request: Record<string, unknown>,
  ): Promise<PageEnvelope<PowerDto>> {
    const page = pythonPageNumber(pyGet(request, 'page'));
    const which = pyGet(request, 'obj');

    let where: { requester_id: number } | { requestee_id: number } | null = null;
    if (which === 'requested') {
      where = { requester_id: actor.id };
    }
    if (which === 'requestee') {
      where = { requestee_id: actor.id };
    }
    if (where === null) {
      // `Paginator([], 10)` -> num_pages 1, count 0.
      return buildPageEnvelope<PowerDto>([], 0, this.ITEMS_PER_PAGE);
    }

    const count = await this.prisma.power.count({ where });
    if (isPageBeyondLast(page, count, this.ITEMS_PER_PAGE)) {
      return buildPageEnvelope<PowerDto>([], count, this.ITEMS_PER_PAGE);
    }
    if (page < 1) {
      // `Paginator.page(0)` raises EmptyPage, which `UserAppsView.post` turns into a 500.
      throw new PythonTypeError('EmptyPage: That page number is less than 1');
    }

    const powers = await this.prisma.power.findMany({
      where,
      orderBy: { id: 'desc' },
      skip: pageOffset(page, this.ITEMS_PER_PAGE),
      take: this.ITEMS_PER_PAGE,
      include: {
        requestee: { include: { auth_user: true } },
        requester: { include: { auth_user: true } },
      },
    });
    return buildPageEnvelope(powers.map(serializePower), count, this.ITEMS_PER_PAGE);
  }

  /**
   * ```python
   * power = Power.objects.get(id = request['id'])
   * power.state = request['state']
   * power.save()
   * if power.state == 1:
   *     mail_params = {...}
   *     self.__mail_service.send_mail(POWER_APPROVED, self.get_users_attr('email'), mail_params)
   * ```
   *
   * **D2:** the caller must be the **requestee** — the person being asked to hold the power.
   * Without that check any member could approve any request and fan the letter out to the
   * whole fund. The refusal is DRF's generic 403, identical to a role denial, so it cannot be
   * used to discover which power ids exist.
   *
   * ⚠️ **`power.state == 1` compares the *submitted* value**, not the stored one: Django does
   * not refresh the instance after `save()`, so `{"state": "1"}` writes 1 to the column (the
   * field coerces) and then compares `'1' == 1`, which is `False` in Python — the row is
   * approved and **no email is sent**. Reproduced literally; the comparison below is against
   * the raw body value.
   *
   * **D5:** every member's address moves from `ToAddresses` to `BccAddresses`.
   */
  private async updatePower(
    actor: AuthenticatedUser,
    request: Record<string, unknown>,
  ): Promise<void> {
    const powerId = toDjangoSmallInt(pyGet(request, 'id'), 'id');
    const submittedState = pyGet(request, 'state');

    const power = await this.prisma.power.findUnique({
      where: { id: powerId },
      include: {
        requestee: { include: { auth_user: true } },
        requester: { include: { auth_user: true } },
      },
    });
    if (power === null) {
      // v1: `Power.objects.get` -> DoesNotExist -> 500 from the view's bare handler.
      throw new PythonTypeError('Power matching query does not exist.');
    }

    // D2 (Q17). Not in v1 at all.
    assertOwnership(actor, power.requestee_id);

    await this.prisma.power.update({
      where: { id: powerId },
      data: { state: toDjangoSmallInt(submittedState, 'state') },
    });

    if (submittedState !== POWER_APPROVED) {
      return;
    }

    const recipients = await this.users.getUserEmails();
    await this.mail.sendMail(
      EmailTemplate.POWER_APPROVED,
      // D5 (Q18): the fan-out is blind. `ToAddresses` is empty and every member is in `Bcc`.
      [],
      {
        requester_full_name: `${power.requester.auth_user.first_name} ${power.requester.auth_user.last_name}`,
        requester_identification: power.requester.identification,
        requestee_full_name: `${power.requestee.auth_user.first_name} ${power.requestee.auth_user.last_name}`,
        requestee_identification: power.requestee.identification,
        // `format_date(power.meeting_date, locale=settings.LANGUAGE_LOCALE)` — the Spanish
        // form. `PowerSerializer` renders the same column as ISO; both are correct.
        meeting_date: formatDateEs(fromDateColumn(power.meeting_date)),
      },
      recipients,
    );
  }
}

/** `request['type'].lower()` — an `AttributeError` (→ 500) for anything but a string. */
function pythonLower(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PythonTypeError(
      `AttributeError: '${value === null ? 'NoneType' : typeof value}' object has no attribute 'lower'`,
    );
  }
  return value.toLowerCase();
}

/**
 * `page > paginator.num_pages` — Python 3 refuses to order a `str` against an `int`, so a
 * quoted page number is a `TypeError` → 500, not a coerced comparison.
 */
function pythonPageNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new PythonTypeError(
      `TypeError: '>' not supported between instances of '${typeof value}' and 'int'`,
    );
  }
  return value;
}

/** Django's `DateField.to_python` for the `YYYY-MM-DD` strings this API receives. */
function parseDateField(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PythonTypeError(
      `ValidationError: '${String(value)}' value has an invalid date format (${field})`,
    );
  }
  const [year, month, day] = value.split('-').map(Number);
  return plainDateToUtcDate({ year, month, day });
}
