"""Address and PNU checks shared by the import and boundary collectors."""
import re


def parcel_address(value):
    """Return only the leading, complete Korean cadastral address."""
    match = re.match(
        r"^\s*((?:경기도|경기)\s+.+?(?:동|가|리)\s+(산\s*)?(\d{1,4})(?:-(\d{1,4}))?)(?=\s|$|[,，(])",
        str(value or ""),
    )
    if not match or int(match[3]) == 0:
        return None
    return {
        "address": re.sub(r"\s+", " ", match[1]).strip(),
        "mountain": bool(match[2]),
        "main": int(match[3]),
        "sub": int(match[4] or 0),
        "locality": re.sub(r"\s+(?:산\s*)?\d.*$", "", match[1]).split()[-1],
    }


def candidate_pnu(raw, address):
    """Use the legal-district prefix only if both sources agree on the lot.

    Onbid's legacy identifiers include a 0/1 land flag. Standard cadastral PNU
    uses 1/2. The named lot determines the flag; a mismatched lot is unresolved.
    Every candidate still requires an exact VWorld feature match.
    """
    raw = str(raw or "").strip()
    lot = parcel_address(address)
    if not lot or not re.fullmatch(r"\d{10}[012]\d{8}", raw):
        return None
    if (int(raw[11:15]), int(raw[15:19])) != (lot["main"], lot["sub"]):
        return None
    return raw[:10] + ("2" if lot["mountain"] else "1") + raw[11:]


def valid_pnu(value):
    return bool(re.fullmatch(r"\d{10}[12]\d{8}", str(value or ""))) and int(str(value)[11:15]) > 0
