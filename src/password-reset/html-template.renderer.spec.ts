import type { AppConfigService } from '../config/app-config.service';
import {
  djangoEscape,
  PasswordResetHtmlRenderer,
  renderFieldErrors,
} from './html-template.renderer';
import {
  FIXED_CSRF_TOKEN,
  V1_COMPLETE,
  V1_CONFIRM_INVALID,
  V1_CONFIRM_MISMATCH,
  V1_CONFIRM_NUMERIC,
  V1_CONFIRM_VALID,
  V1_CSRF_FAILURE_BAD_TOKEN,
  V1_CSRF_FAILURE_NO_COOKIE,
  V1_DONE,
  V1_FORM,
} from './v1-pages.fixture';

const NO_COOKIE_HELP =
  '  <p>You are seeing this message because this site requires a CSRF cookie when ' +
  'submitting forms. This cookie is required for security reasons, to ensure that your ' +
  'browser is not being hijacked by third parties.</p>\n' +
  '  <p>If you have configured your browser to disable cookies, please re-enable them, at ' +
  'least for this site, or for &#39;same-origin&#39; requests.</p>\n\n';

/**
 * Byte-for-byte against `Django==2.2.27`'s own output — the same discipline the Phase 2 email
 * templates are held to. Whitespace is the contract here: Django leaves the indentation of
 * every `{% block %}`, `{% load %}` and `{% if %}` tag behind, and the four pages mix tabs and
 * spaces because the originals do.
 */
describe('PasswordResetHtmlRenderer', () => {
  const renderer = new PasswordResetHtmlRenderer({
    hostUrlApp: 'http://localhost:3000',
  } as AppConfigService);

  it('renders password_reset_form.html exactly', () => {
    expect(renderer.render('password_reset_form.eta', { csrf_token: FIXED_CSRF_TOKEN })).toBe(
      V1_FORM,
    );
  });

  it('renders password_reset_done.html exactly', () => {
    expect(renderer.render('password_reset_done.eta')).toBe(V1_DONE);
  });

  it('renders password_reset_complete.html exactly, with {% host %} resolved', () => {
    expect(renderer.render('password_reset_complete.eta')).toBe(V1_COMPLETE);
    expect(V1_COMPLETE).toContain('<a href="http://localhost:3000">Ir a página principal</a>');
  });

  it('renders the validlink branch of password_reset_confirm.html exactly', () => {
    expect(
      renderer.render('password_reset_confirm.eta', {
        validlink: 'true',
        csrf_token: FIXED_CSRF_TOKEN,
        field_errors: renderFieldErrors([]),
      }),
    ).toBe(V1_CONFIRM_VALID);
  });

  it('renders the else branch exactly, and it contains no csrf_token', () => {
    expect(
      renderer.render('password_reset_confirm.eta', {
        validlink: '',
        csrf_token: '',
        field_errors: '',
      }),
    ).toBe(V1_CONFIRM_INVALID);
    expect(V1_CONFIRM_INVALID).not.toContain('csrfmiddlewaretoken');
  });

  it('reproduces the {% if form.errors %} block, whitespace included', () => {
    expect(
      renderer.render('password_reset_confirm.eta', {
        validlink: 'true',
        csrf_token: FIXED_CSRF_TOKEN,
        field_errors: renderFieldErrors(["The two password fields didn't match."]),
      }),
    ).toBe(V1_CONFIRM_MISMATCH);

    expect(
      renderer.render('password_reset_confirm.eta', {
        validlink: 'true',
        csrf_token: FIXED_CSRF_TOKEN,
        field_errors: renderFieldErrors(['This password is entirely numeric.']),
      }),
    ).toBe(V1_CONFIRM_NUMERIC);
  });

  it('renders both CSRF failure variants exactly', () => {
    expect(renderer.render('csrf_failure.eta', { no_cookie_help: NO_COOKIE_HELP })).toBe(
      V1_CSRF_FAILURE_NO_COOKIE,
    );
    expect(renderer.render('csrf_failure.eta', { no_cookie_help: '' })).toBe(
      V1_CSRF_FAILURE_BAD_TOKEN,
    );
  });

  describe('djangoEscape', () => {
    it("renders an apostrophe as &#39;, which is what Django's escape() does", () => {
      expect(djangoEscape("didn't")).toBe('didn&#39;t');
    });

    it('escapes the other four, ampersand first', () => {
      expect(djangoEscape('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    });
  });

  describe('renderFieldErrors', () => {
    it('is a single indented blank line when there are none', () => {
      expect(renderFieldErrors([])).toBe('                \n');
    });

    it('renders several errors as several <li>s in one errorlist', () => {
      const html = renderFieldErrors(['One.', 'Two.']);
      expect(html).toContain('<ul class="errorlist"><li>One.</li><li>Two.</li></ul>');
    });

    it('escapes the message', () => {
      expect(renderFieldErrors(["<b>didn't</b>"])).toContain('&lt;b&gt;didn&#39;t&lt;/b&gt;');
    });
  });
});
