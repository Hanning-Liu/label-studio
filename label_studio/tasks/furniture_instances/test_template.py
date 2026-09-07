import unittest
import xml.etree.ElementTree as ET

from . import FURNITURE_TYPE_CHOICES
from .template import build_template
from .validation import REFERENCE_CONTROLS

SOURCE_CONFIG = '''<View>
  <Image name="image" value="$image" occupancyV1="true" />
  <RectangleLabels name="room_rectangle" toName="image"><Label value="Study" /></RectangleLabels>
  <PolygonLabels name="room_polygon" toName="image"><Label value="Study" /></PolygonLabels>
  <RectangleLabels name="portal_rectangle" toName="image"><Label value="Door" /></RectangleLabels>
  <VectorLabels name="portal_vector" toName="image"><Label value="Open passage" /></VectorLabels>
  <Rectangle name="zone_rectangle" toName="image" />
  <Polygon name="zone_polygon" toName="image" />
  <Labels name="function_zone" toName="image"><Label value="Study/work" /></Labels>
  <VectorLabels name="connection_vector" toName="image"><Label value="Open passage" /></VectorLabels>
  <VectorLabels name="visual_connection_vector" toName="image"><Label value="Visual only" /></VectorLabels>
  <Choices name="connection_review" toName="image"><Choice value="Reviewed" /></Choices>
  <Choices name="visual_connection_review" toName="image"><Choice value="Reviewed" /></Choices>
  <Rectangle name="occupancy_rectangle" toName="image" />
  <Polygon name="occupancy_polygon" toName="image" />
  <Labels name="occupancy_type" toName="image"><Label value="furniture_group" /></Labels>
  <VectorLabels name="occupancy_barrier_vector" toName="image"><Label value="wall_barrier" /></VectorLabels>
</View>'''


class FurnitureInstanceTemplateTests(unittest.TestCase):
    def test_copies_l3_references_and_adds_stable_l4_controls(self):
        root = ET.fromstring(build_template(SOURCE_CONFIG))
        image = root.find('Image')
        self.assertEqual(image.get('furnitureInstancesV1'), 'true')
        self.assertEqual(image.get('furnitureInstanceOrientation'), 'true')
        self.assertIsNone(image.get('occupancyV1'))
        hidden = next(
            element
            for element in root.iter('View')
            if element.get('className') == 'furniture-instance-reference-controls'
        )
        copied = {element.get('name') for element in hidden if element.get('name')}
        self.assertEqual(copied, REFERENCE_CONTROLS)
        self.assertTrue(all(element.get('toName') == 'image' for element in hidden if element.get('name')))
        self.assertEqual(root.find("Rectangle[@name='furniture_instance_rectangle']").get('canRotate'), 'true')
        self.assertIsNotNone(root.find("Polygon[@name='furniture_instance_polygon']"))

    def test_uses_chinese_display_and_exact_26_stable_english_aliases(self):
        root = ET.fromstring(build_template(SOURCE_CONFIG))
        choices = root.find("Choices[@name='furniture_instance_type']")
        actual = [(choice.get('alias'), choice.get('value')) for choice in choices.findall('Choice')]
        self.assertEqual(actual, list(FURNITURE_TYPE_CHOICES))
        self.assertEqual(len(actual), 26)
        self.assertIn(('armchair', '扶手椅'), actual)
        orientation_view = root.find("View[@className='furniture-instance-orientation-controls']")
        self.assertIsNotNone(orientation_view)
        self.assertEqual(orientation_view.get('style'), 'display: none;')
        direction_control = orientation_view.find("VectorLabels[@name='furniture_front_direction']")
        edge_control = orientation_view.find("VectorLabels[@name='furniture_front_edge']")
        direction = direction_control.find('Label')
        edge = edge_control.find('Label')
        self.assertEqual((direction.get('alias'), direction.get('value')), ('front_direction', '正面方向'))
        self.assertEqual((edge.get('alias'), edge.get('value')), ('front_edge', '正面边'))
        for control in (direction_control, edge_control):
            self.assertEqual(control.get('closable'), 'false')
            self.assertEqual(control.get('curves'), 'false')
            self.assertEqual(control.get('minPoints'), '2')
            self.assertEqual(control.get('maxPoints'), '2')
            self.assertEqual(control.get('snap'), 'none')

    def test_does_not_rename_or_repurpose_l1_l3_controls(self):
        def signature(element):
            return (
                element.tag,
                dict(element.attrib),
                tuple(signature(child) for child in element),
            )

        source = ET.fromstring(SOURCE_CONFIG)
        output = ET.fromstring(build_template(SOURCE_CONFIG))
        hidden = next(
            element
            for element in output.iter('View')
            if element.get('className') == 'furniture-instance-reference-controls'
        )
        source_by_name = {
            element.get('name'): signature(element)
            for element in source.iter()
            if element.get('name') in REFERENCE_CONTROLS
        }
        copied_by_name = {
            element.get('name'): signature(element)
            for element in hidden
            if element.get('name')
        }
        self.assertEqual(copied_by_name, source_by_name)

    def test_rejects_missing_source_control_or_l4_name_collision(self):
        missing = SOURCE_CONFIG.replace('<Polygon name="occupancy_polygon" toName="image" />', '')
        with self.assertRaisesRegex(ValueError, '缺少控件'):
            build_template(missing)
        collision = SOURCE_CONFIG.replace('</View>', '<Polygon name="furniture_instance_polygon" toName="image" /></View>')
        with self.assertRaisesRegex(ValueError, '已被来源占用'):
            build_template(collision)


if __name__ == '__main__':
    unittest.main()
