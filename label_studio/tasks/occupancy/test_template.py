import unittest
import xml.etree.ElementTree as ET

from .template import build_template, ensure_barrier_control
from .validation import REQUIRED_REFERENCES


CONFIG = '''<View>
  <Image name="image" value="$image" occupancyV1="true" />
  <View className="occupancy-reference-controls" style="display: none;">
    <Labels name="occupancy_type" toName="image">
      <Label value="furniture_group" />
    </Labels>
  </View>
  <Rectangle name="occupancy_rectangle" toName="image" />
  <Polygon name="occupancy_polygon" toName="image" />
  <Header value="existing" />
</View>'''

SOURCE_CONFIG = '''<View><Image name="image" value="$image"/>
<RectangleLabels name="room_rectangle" toName="image"/><PolygonLabels name="room_polygon" toName="image"/>
<RectangleLabels name="portal_rectangle" toName="image"/><VectorLabels name="portal_vector" toName="image"/>
<Rectangle name="zone_rectangle" toName="image"/><Polygon name="zone_polygon" toName="image"/>
<Labels name="function_zone" toName="image"/>
<VectorLabels name="connection_vector" toName="image"/><VectorLabels name="visual_connection_vector" toName="image"/>
<Choices name="connection_review" toName="image"/><Choices name="visual_connection_review" toName="image"/>
</View>'''

WINDOW_CONTROL = (
    '<VectorLabels name="window_vector" toName="image" closable="false" curves="true" minPoints="2">'
    '<Label value="Window"/></VectorLabels>'
)


class OccupancyBarrierTemplateTests(unittest.TestCase):
    def test_window_reference_control_is_optional_and_losslessly_copied(self):
        legacy = ET.fromstring(build_template(SOURCE_CONFIG))
        legacy_names = {element.get('name') for element in legacy.iter() if element.get('name')}
        self.assertTrue(REQUIRED_REFERENCES <= legacy_names)
        self.assertNotIn('window_vector', legacy_names)

        source = SOURCE_CONFIG.replace('</View>', f'{WINDOW_CONTROL}</View>')
        root = ET.fromstring(build_template(source))
        windows = [element for element in root.iter('VectorLabels') if element.get('name') == 'window_vector']
        self.assertEqual(len(windows), 1)
        self.assertEqual(
            {key: windows[0].get(key) for key in ('toName', 'closable', 'curves', 'minPoints')},
            {'toName': 'image', 'closable': 'false', 'curves': 'true', 'minPoints': '2'},
        )

        missing_required = SOURCE_CONFIG.replace('name="portal_vector"', 'name="not_portal_vector"')
        with self.assertRaisesRegex(ValueError, 'portal_vector'):
            build_template(missing_required)

    def test_adds_one_hidden_control_and_is_idempotent(self):
        before = ET.fromstring(CONFIG)
        updated = ensure_barrier_control(CONFIG)
        root = ET.fromstring(updated)
        self.assertEqual(
            [(element.tag, element.get('name')) for element in before if element.get('name')],
            [(element.tag, element.get('name')) for element in root
             if element.get('name') and element.get('name') != 'occupancy_barrier_vector'],
        )
        self.assertEqual(root.findall('VectorLabels'), [])
        hidden = next(element for element in root.iter('View') if element.get('className') == 'occupancy-reference-controls')
        barriers = [element for element in hidden.findall('VectorLabels') if element.get('name') == 'occupancy_barrier_vector']
        self.assertEqual(len(barriers), 1)
        self.assertEqual(barriers[0].get('toName'), 'image')
        self.assertEqual([(label.get('value'), label.get('background')) for label in barriers[0]], [('wall_barrier', '#374151')])
        self.assertEqual(ensure_barrier_control(updated), updated)

    def test_moves_existing_top_level_control_into_hidden_container(self):
        top_level = CONFIG.replace(
            '<Header',
            '<VectorLabels name="occupancy_barrier_vector" toName="image">'
            '<Label value="wall_barrier" background="#374151" />'
            '</VectorLabels><Header',
        )
        updated = ensure_barrier_control(top_level)
        root = ET.fromstring(updated)
        self.assertEqual(root.findall('VectorLabels'), [])
        hidden = next(element for element in root.iter('View') if element.get('className') == 'occupancy-reference-controls')
        self.assertEqual(
            len([element for element in hidden.findall('VectorLabels') if element.get('name') == 'occupancy_barrier_vector']),
            1,
        )
        self.assertEqual(ensure_barrier_control(updated), updated)

    def test_rejects_a_conflicting_control_name(self):
        conflict = CONFIG.replace('<Header', '<Rectangle name="occupancy_barrier_vector" toName="image" /><Header')
        with self.assertRaisesRegex(ValueError, '不兼容'):
            ensure_barrier_control(conflict)


if __name__ == '__main__':
    unittest.main()
