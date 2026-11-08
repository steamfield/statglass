import { render, screen } from "@testing-library/react";
import { CardGrid } from "./card-grid";

it("continues entrance ordering after earlier cards", () => {
  render(
    <CardGrid
      items={["Events", "Apps"]}
      getKey={(item) => item}
      staggerFrom={6}
    >
      {(item) => <p>{item}</p>}
    </CardGrid>
  );
  expect(
    screen.getByText("Events").parentElement?.style.getPropertyValue("--j")
  ).toBe("6");
  expect(
    screen.getByText("Apps").parentElement?.style.getPropertyValue("--j")
  ).toBe("7");
});

it("starts entrance ordering at zero by default", () => {
  render(
    <CardGrid items={["CPU"]} getKey={(item) => item}>
      {(item) => <p>{item}</p>}
    </CardGrid>
  );
  expect(
    screen.getByText("CPU").parentElement?.style.getPropertyValue("--j")
  ).toBe("0");
});
