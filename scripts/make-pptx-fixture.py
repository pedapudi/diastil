#!/usr/bin/env python3
"""Deterministic .pptx fixture for the import tests — stdlib only.
Two slides on a 16:9 canvas exercising: theme colors + fonts, master/
layout placeholder inheritance (title has NO xfrm on slide 1), body
bullets with levels, a rotated rounded rect, a picture, a table, a
single-series bar chart, speaker notes, and a hidden third slide."""
import zipfile, struct, zlib, sys

NS_P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
NS_A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
NS_R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
NS_C = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"'

def png_2x2():
    # 2x2 red PNG, hand-assembled
    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', 2, 2, 8, 2, 0, 0, 0)
    raw = b''.join(b'\x00' + b'\xff\x00\x00' * 2 for _ in range(2))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))

CONTENT_TYPES = f'''<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>'''

ROOT_RELS = '''<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>'''

PRESENTATION = f'''<?xml version="1.0"?>
<p:presentation {NS_P} {NS_A} {NS_R}>
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>
<p:sldId id="256" r:id="rId2"/>
<p:sldId id="257" r:id="rId3"/>
<p:sldId id="258" r:id="rId4"/>
</p:sldIdLst>
<p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>'''

PRES_RELS = '''<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/>
</Relationships>'''

THEME = f'''<?xml version="1.0"?>
<a:theme {NS_A} name="fixture"><a:themeElements>
<a:clrScheme name="fx">
<a:dk1><a:srgbClr val="1A2B3C"/></a:dk1><a:lt1><a:srgbClr val="FDFBF7"/></a:lt1>
<a:dk2><a:srgbClr val="30404F"/></a:dk2><a:lt2><a:srgbClr val="EEE9E0"/></a:lt2>
<a:accent1><a:srgbClr val="2E6FBA"/></a:accent1><a:accent2><a:srgbClr val="C05330"/></a:accent2>
<a:accent3><a:srgbClr val="6F9E4C"/></a:accent3><a:accent4><a:srgbClr val="8A5FA8"/></a:accent4>
<a:accent5><a:srgbClr val="2FA3A0"/></a:accent5><a:accent6><a:srgbClr val="C7A230"/></a:accent6>
<a:hlink><a:srgbClr val="2E6FBA"/></a:hlink><a:folHlink><a:srgbClr val="8A5FA8"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="fx"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont>
<a:minorFont><a:latin typeface="Verdana"/></a:minorFont></a:fontScheme>
<a:fmtScheme name="fx"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>'''

MASTER = f'''<?xml version="1.0"?>
<p:sldMaster {NS_P} {NS_A} {NS_R}>
<p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title Placeholder"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>
</p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst/>
<p:txStyles>
<p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4000" b="1"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>
<p:bodyStyle>
<a:lvl1pPr marL="342900"><a:buChar char="&#8226;"/><a:defRPr sz="2400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>
<a:lvl2pPr marL="742950"><a:buChar char="&#8211;"/><a:defRPr sz="2000"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl2pPr>
</p:bodyStyle>
<p:otherStyle/>
</p:txStyles></p:sldMaster>'''

MASTER_RELS = '''<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>'''

LAYOUT = f'''<?xml version="1.0"?>
<p:sldLayout {NS_P} {NS_A} {NS_R}>
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="838200" y="1825625"/><a:ext cx="10515600" cy="4351338"/></a:xfrm></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>
</p:spTree></p:cSld></p:sldLayout>'''

LAYOUT_RELS = '''<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>'''

SLIDE1 = f'''<?xml version="1.0"?>
<p:sld {NS_P} {NS_A} {NS_R}>
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
<p:spPr/>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Quarterly Review</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body 1"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
<p:spPr/>
<p:txBody><a:bodyPr/><a:lstStyle/>
<a:p><a:r><a:t>Revenue grew steadily</a:t></a:r></a:p>
<a:p><a:pPr lvl="1"/><a:r><a:t>EMEA led the growth</a:t></a:r></a:p>
<a:p><a:r><a:rPr b="1"><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></a:rPr><a:t>Costs held flat</a:t></a:r></a:p>
</p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="4" name="Badge"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm rot="2700000"><a:off x="9906000" y="4114800"/><a:ext cx="1524000" cy="914400"/></a:xfrm>
<a:prstGeom prst="roundRect"/><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr></a:solidFill>
<a:ln w="19050"><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:ln></p:spPr>
<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="1400"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>NEW</a:t></a:r></a:p></p:txBody></p:sp>
<p:pic><p:nvPicPr><p:cNvPr id="5" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="rId2"/><a:stretch/></p:blipFill>
<p:spPr><a:xfrm><a:off x="457200" y="5638800"/><a:ext cx="914400" cy="914400"/></a:xfrm></p:spPr></p:pic>
</p:spTree></p:cSld></p:sld>'''

SLIDE1_RELS = '''<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>'''

NOTES1 = f'''<?xml version="1.0"?>
<p:notes {NS_P} {NS_A} {NS_R}>
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>
<a:p><a:r><a:t>Open with the EMEA anecdote.</a:t></a:r></a:p>
</p:txBody></p:sp></p:spTree></p:cSld></p:notes>'''

SLIDE2 = f'''<?xml version="1.0"?>
<p:sld {NS_P} {NS_A} {NS_R}>
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 2"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Numbers</a:t></a:r></a:p></p:txBody></p:sp>
<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
<p:xfrm><a:off x="838200" y="1825625"/><a:ext cx="4572000" cy="1371600"/></p:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
<a:tbl><a:tblGrid><a:gridCol w="2286000"/><a:gridCol w="2286000"/></a:tblGrid>
<a:tr h="457200"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr b="1"/><a:t>Region</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:tcPr></a:tc>
<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr b="1"/><a:t>Share</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:tcPr></a:tc></a:tr>
<a:tr h="457200"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>EMEA</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>44%</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr>
</a:tbl></a:graphicData></a:graphic></p:graphicFrame>
<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
<p:xfrm><a:off x="6096000" y="1825625"/><a:ext cx="4572000" cy="2743200"/></p:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
<c:chart {NS_C} {NS_R} r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame>
</p:spTree></p:cSld></p:sld>'''

SLIDE2_RELS = '''<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
</Relationships>'''

CHART1 = f'''<?xml version="1.0"?>
<c:chartSpace {NS_C} {NS_A} {NS_R}><c:chart><c:plotArea>
<c:barChart><c:barDir val="col"/>
<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>s</c:f><c:strCache><c:pt idx="0"><c:v>Share</c:v></c:pt></c:strCache></c:strRef></c:tx>
<c:cat><c:strRef><c:f>c</c:f><c:strCache>
<c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt><c:pt idx="2"><c:v>Q3</c:v></c:pt>
</c:strCache></c:strRef></c:cat>
<c:val><c:numRef><c:f>v</c:f><c:numCache>
<c:pt idx="0"><c:v>12</c:v></c:pt><c:pt idx="1"><c:v>19</c:v></c:pt><c:pt idx="2"><c:v>7</c:v></c:pt>
</c:numCache></c:numRef></c:val></c:ser>
</c:barChart></c:plotArea></c:chart></c:chartSpace>'''

SLIDE3 = f'''<?xml version="1.0"?>
<p:sld {NS_P} {NS_A} {NS_R} show="0">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>HIDDEN SLIDE</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>'''

SLIDE3_RELS = SLIDE2_RELS.replace('<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>', '')

out = sys.argv[1] if len(sys.argv) > 1 else 'src/ingest/__fixtures__/basic.pptx'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', CONTENT_TYPES)
    z.writestr('_rels/.rels', ROOT_RELS)
    z.writestr('ppt/presentation.xml', PRESENTATION)
    z.writestr('ppt/_rels/presentation.xml.rels', PRES_RELS)
    z.writestr('ppt/theme/theme1.xml', THEME)
    z.writestr('ppt/slideMasters/slideMaster1.xml', MASTER)
    z.writestr('ppt/slideMasters/_rels/slideMaster1.xml.rels', MASTER_RELS)
    z.writestr('ppt/slideLayouts/slideLayout1.xml', LAYOUT)
    z.writestr('ppt/slideLayouts/_rels/slideLayout1.xml.rels', LAYOUT_RELS)
    z.writestr('ppt/slides/slide1.xml', SLIDE1)
    z.writestr('ppt/slides/_rels/slide1.xml.rels', SLIDE1_RELS)
    z.writestr('ppt/slides/slide2.xml', SLIDE2)
    z.writestr('ppt/slides/_rels/slide2.xml.rels', SLIDE2_RELS)
    z.writestr('ppt/slides/slide3.xml', SLIDE3)
    z.writestr('ppt/slides/_rels/slide3.xml.rels', SLIDE3_RELS)
    z.writestr('ppt/charts/chart1.xml', CHART1)
    z.writestr('ppt/notesSlides/notesSlide1.xml', NOTES1)
    z.writestr('ppt/media/image1.png', png_2x2())
print(f'wrote {out}')
