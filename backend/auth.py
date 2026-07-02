import os
import jwt
from fastapi import HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jwt import PyJWKClient

security = HTTPBearer()

# Derived from the VITE_CLERK_PUBLISHABLE_KEY decoded payload
CLERK_DOMAIN = os.environ.get("CLERK_DOMAIN", "elegant-grouse-44.clerk.accounts.dev")
CLERK_JWKS_URL = f"https://{CLERK_DOMAIN}/.well-known/jwks.json"

jwks_client = PyJWKClient(CLERK_JWKS_URL)

def get_current_user(credentials: HTTPAuthorizationCredentials = Security(security)) -> str:
    """
    Validates the Clerk JWT token and extracts the user_id (sub).
    Raises HTTP 401 if the token is missing, invalid, or expired.
    """
    token = credentials.credentials
    try:
        signing_key = jwks_client.get_signing_key_from_jwt(token)
        data = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            options={"verify_aud": False}
        )
        user_id = data.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token: missing subject")
        return user_id
    except jwt.PyJWTError as e:
        raise HTTPException(status_code=401, detail=f"Invalid authentication token: {e}")
    except Exception as e:
        raise HTTPException(status_code=401, detail="Authentication failed")
