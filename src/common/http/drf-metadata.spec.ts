import { DrfException } from './drf.exception';
import { DRF_VIEW_METADATA, drfOptionsMetadata } from './drf-metadata';

/**
 * Parity finding **F4**. The two documents below are the **captured** bodies of
 * `OPTIONS /api/user/activate/13` and `OPTIONS /api-token-auth` against the live v1
 * (`~/Projects/Fondo-API` @ `5bef585`, gunicorn 19.9.0, `api.settings.production`), pasted
 * verbatim — not rebuilt from the class attributes, so a wrong assumption about DRF's
 * defaults cannot agree with itself.
 */
describe('DRF SimpleMetadata (APIView.options)', () => {
  const V1_USER_ACTIVATE =
    '{"name":"User Activate","description":"","renders":["application/json","text/html"],' +
    '"parses":["application/json","application/x-www-form-urlencoded","multipart/form-data"]}';

  const V1_OBTAIN_AUTH_TOKEN =
    '{"name":"Obtain Auth Token","description":"","renders":["application/json"],' +
    '"parses":["application/x-www-form-urlencoded","multipart/form-data","application/json"]}';

  it('reproduces UserActivateView’s document byte for byte, 172 bytes', () => {
    const rendered = JSON.stringify(DRF_VIEW_METADATA.UserActivateView);

    expect(rendered).toBe(V1_USER_ACTIVATE);
    expect(Buffer.byteLength(rendered)).toBe(172);
  });

  it('reproduces ObtainAuthToken’s document byte for byte, 164 bytes', () => {
    // ⚠️ Its `parser_classes` are (Form, MultiPart, JSON) — a *different order* from DRF's
    // default, and `renderer_classes` is JSON only, which is why this view has no
    // `Vary: Accept`.
    const rendered = JSON.stringify(DRF_VIEW_METADATA.ObtainAuthToken);

    expect(rendered).toBe(V1_OBTAIN_AUTH_TOKEN);
    expect(Buffer.byteLength(rendered)).toBe(164);
  });

  it('has no `actions` key — neither view has `get_serializer` in DRF 3.11.2', () => {
    for (const document of Object.values(DRF_VIEW_METADATA)) {
      expect(Object.keys(document)).toEqual(['name', 'description', 'renders', 'parses']);
    }
  });

  describe('drfOptionsMetadata', () => {
    it('answers OPTIONS with the document', () => {
      expect(drfOptionsMetadata('OPTIONS', 'UserActivateView', 'POST, OPTIONS')).toBe(
        DRF_VIEW_METADATA.UserActivateView,
      );
    });

    it.each(['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'POST'])(
      '405s %s, with Allow — `http_method_not_allowed`',
      (method) => {
        try {
          drfOptionsMetadata(method, 'ObtainAuthToken', 'POST, OPTIONS');
        } catch (error) {
          expect(error).toBeInstanceOf(DrfException);
          const drf = error as DrfException;
          expect(drf.getStatus()).toBe(405);
          expect(drf.drfBody).toEqual({ detail: `Method "${method}" not allowed.` });
          expect(drf.drfHeaders).toEqual({ Allow: 'POST, OPTIONS' });
          return;
        }
        throw new Error('expected a DrfException');
      },
    );

    it('is case-sensitive, as `request.method` always arrives upper-cased', () => {
      expect(() => drfOptionsMetadata('options', 'ObtainAuthToken', 'POST, OPTIONS')).toThrow(
        DrfException,
      );
    });
  });
});
